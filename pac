/* ================================================================
   ПАКЕТ: PKG_FSSP_VALIDATION
   Назначение:
     1. Валидация XML постановления (Restrictn) по требованиям
        IMG_8022 (пп.1-5), IMG_8019-8021 (проверки по DocType)
     2. Формирование ответного XML Report с тегами ошибок
        вместо текстовых квитанций
   Структура таблицы (адаптировать под схему):
     FSSP_RESTRICTIONS (
         DOC_NUM       VARCHAR2(25),
         DOC_TYPE      VARCHAR2(50),
         XML_RESTRICTN XMLTYPE,
         INTERNAL_KEY  VARCHAR2(40),
         EP_STATUS     VARCHAR2(10)   -- 'VALID' | 'INVALID' | NULL
     )
     FSSP_REPORTS (
         DOC_NUM       VARCHAR2(25),
         XML_REPORT    XMLTYPE,
         CREATED_AT    DATE
     )
   ================================================================ */

-- ================================================================
-- СПЕЦИФИКАЦИЯ ПАКЕТА
-- ================================================================
CREATE OR REPLACE PACKAGE pkg_fssp_validation AS

    -- Коды статусов ответа (RestrictionAnswerType)
    C_ANS_PARTIAL_EXEC   CONSTANT VARCHAR2(2) := '04'; -- исполнено частично
    C_ANS_BAD_CONTENT    CONSTANT VARCHAR2(2) := '05'; -- некорректное содержание
    C_ANS_NO_OBJECT      CONSTANT VARCHAR2(2) := '07'; -- объект не найден
    C_ANS_ALREADY_DONE   CONSTANT VARCHAR2(2) := '08'; -- уже исполнено ранее

    -- Коды статусов документа (StateId для DocumentStateReceipt)
    C_STATE_BAD_SIGN     CONSTANT VARCHAR2(2) := '90'; -- подпись не прошла
    C_STATE_BAD_XSD      CONSTANT VARCHAR2(2) := '91'; -- не соответствует XSD
    C_STATE_BAD_FORMAT   CONSTANT VARCHAR2(2) := '92'; -- ошибка ФЛК
    C_STATE_DUPLICATE    CONSTANT VARCHAR2(2) := '94'; -- дубликат

    -- Основная процедура: валидация + формирование Report XML
    -- p_doc_num   — номер постановления
    -- p_report_xml — OUT: сформированный XML Report
    -- p_state_id   — OUT: итоговый код статуса (NULL = успех)
    -- p_message    — OUT: текстовое описание результата
    PROCEDURE validate_and_report (
        p_doc_num    IN  VARCHAR2,
        p_report_xml OUT XMLTYPE,
        p_state_id   OUT VARCHAR2,
        p_message    OUT VARCHAR2
    );

    -- Публичная функция: читает значение узла XML по XPath
    FUNCTION get_xml_val (
        p_xml   IN XMLTYPE,
        p_xpath IN VARCHAR2
    ) RETURN VARCHAR2;

    -- Публичная функция: формирует Report XML с минимальным набором тегов
    FUNCTION build_report_xml (
        p_restrictn_key    IN VARCHAR2,
        p_ip_key           IN VARCHAR2,
        p_doc_date         IN VARCHAR2,
        p_restr_doc_num    IN VARCHAR2,
        p_restr_doc_date   IN VARCHAR2,
        p_answer_type      IN VARCHAR2,
        p_legal_imp        IN VARCHAR2,
        p_external_key     IN VARCHAR2
    ) RETURN XMLTYPE;

END pkg_fssp_validation;
/


-- ================================================================
-- ТЕЛО ПАКЕТА
-- ================================================================
CREATE OR REPLACE PACKAGE BODY pkg_fssp_validation AS

    -- ============================================================
    -- ПРИВАТНЫЕ ТИПЫ
    -- ============================================================

    -- Запись об ошибке валидации
    TYPE t_error_rec IS RECORD (
        section  VARCHAR2(100),
        field    VARCHAR2(200),
        detail   VARCHAR2(4000)
    );
    TYPE t_error_tab IS TABLE OF t_error_rec INDEX BY PLS_INTEGER;

    -- ============================================================
    -- ПРИВАТНЫЕ КОНСТАНТЫ
    -- ============================================================
    C_DATE_FMT  CONSTANT VARCHAR2(10) := 'YYYY-MM-DD';
    C_XML_DECL  CONSTANT VARCHAR2(50) := '<?xml version="1.0" encoding="UTF-8"?>';

    -- ============================================================
    -- ПУБЛИЧНАЯ ФУНКЦИЯ: читает значение узла XML
    -- ============================================================
    FUNCTION get_xml_val (
        p_xml   IN XMLTYPE,
        p_xpath IN VARCHAR2
    ) RETURN VARCHAR2
    IS
        v_result VARCHAR2(4000);
    BEGIN
        SELECT TRIM(
                   XMLCAST(
                       XMLQUERY(p_xpath PASSING p_xml RETURNING CONTENT)
                       AS VARCHAR2(4000)
                   )
               )
          INTO v_result
          FROM DUAL;

        IF v_result = '' THEN v_result := NULL; END IF;
        RETURN v_result;
    EXCEPTION
        WHEN OTHERS THEN RETURN NULL;
    END get_xml_val;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: добавляет ошибку в коллекцию
    -- ============================================================
    PROCEDURE push_error (
        p_errors  IN OUT t_error_tab,
        p_section IN     VARCHAR2,
        p_field   IN     VARCHAR2,
        p_detail  IN     VARCHAR2 DEFAULT NULL
    ) IS
        v_idx PLS_INTEGER := p_errors.COUNT + 1;
    BEGIN
        p_errors(v_idx).section := p_section;
        p_errors(v_idx).field   := p_field;
        p_errors(v_idx).detail  := p_detail;
    END push_error;

    -- ============================================================
    -- ПРИВАТНАЯ ФУНКЦИЯ: формирует XML-узел LegalImpossibility
    -- из коллекции ошибок (первые 50 символов для СМЭВ3)
    -- ============================================================
    FUNCTION build_legal_impossibility (
        p_errors IN t_error_tab
    ) RETURN VARCHAR2
    IS
        v_text VARCHAR2(4000) := '';
    BEGIN
        FOR i IN 1 .. p_errors.COUNT LOOP
            v_text := v_text
                || '[' || i || '] '
                || p_errors(i).section || ': '
                || p_errors(i).field;
            IF p_errors(i).detail IS NOT NULL THEN
                v_text := v_text || ' (' || p_errors(i).detail || ')';
            END IF;
            v_text := v_text || '; ';
        END LOOP;
        RETURN SUBSTR(TRIM(v_text), 1, 4000);
    END build_legal_impossibility;

    -- ============================================================
    -- ПУБЛИЧНАЯ ФУНКЦИЯ: строит минимальный Report XML
    -- Теги соответствуют Report_full.xml
    -- ============================================================
    FUNCTION build_report_xml (
        p_restrictn_key    IN VARCHAR2,
        p_ip_key           IN VARCHAR2,
        p_doc_date         IN VARCHAR2,
        p_restr_doc_num    IN VARCHAR2,
        p_restr_doc_date   IN VARCHAR2,
        p_answer_type      IN VARCHAR2,
        p_legal_imp        IN VARCHAR2,
        p_external_key     IN VARCHAR2
    ) RETURN XMLTYPE
    IS
        v_xml_str  VARCHAR2(32767);
        v_ext_key  VARCHAR2(60);
    BEGIN
        -- ExternalKey: если не передан — генерируем
        v_ext_key := NVL(
            p_external_key,
            'BANK-REPORT-' || TO_CHAR(SYSDATE,'YYYYMMDD-HH24MISS')
        );

        v_xml_str :=
            C_XML_DECL || CHR(10) ||
            '<Report>' || CHR(10) ||

            -- Обязательные поля (Табл.10)
            '  <ExternalKey>'          || v_ext_key                    || '</ExternalKey>'          || CHR(10) ||
            '  <RestrctnInternalKey>'  || NVL(p_restrictn_key,'')      || '</RestrctnInternalKey>'  || CHR(10) ||
            '  <IpInternalKey>'        || NVL(p_ip_key,'')             || '</IpInternalKey>'        || CHR(10) ||
            '  <DocDate>'              || NVL(p_doc_date,
                                             TO_CHAR(SYSDATE,C_DATE_FMT)) || '</DocDate>'           || CHR(10) ||

            -- Необязательные поля
            CASE WHEN p_restr_doc_num  IS NOT NULL
                 THEN '  <RestrDocNumber>' || p_restr_doc_num  || '</RestrDocNumber>' || CHR(10)
                 ELSE '' END ||
            CASE WHEN p_restr_doc_date IS NOT NULL
                 THEN '  <RestrDocDate>'   || p_restr_doc_date || '</RestrDocDate>'   || CHR(10)
                 ELSE '' END ||

            -- Тип ответа — обязателен
            '  <RestrictionAnswerType>' || NVL(p_answer_type,'05') || '</RestrictionAnswerType>' || CHR(10) ||

            -- Причина невозможности исполнения (первые 50 символов — для СМЭВ3)
            CASE WHEN p_legal_imp IS NOT NULL THEN
                '  <LegalImpossibility>' || p_legal_imp || '</LegalImpossibility>' || CHR(10)
            ELSE '' END ||

            '</Report>';

        RETURN XMLTYPE.createXML(v_xml_str);

    EXCEPTION
        WHEN OTHERS THEN
            -- Если что-то пошло не так при сборке XML — возвращаем минимум
            RETURN XMLTYPE.createXML(
                C_XML_DECL || CHR(10) ||
                '<Report>' ||
                '<ExternalKey>' || v_ext_key || '</ExternalKey>' ||
                '<RestrctnInternalKey>' || NVL(p_restrictn_key,'') || '</RestrctnInternalKey>' ||
                '<IpInternalKey>' || NVL(p_ip_key,'') || '</IpInternalKey>' ||
                '<DocDate>' || TO_CHAR(SYSDATE,C_DATE_FMT) || '</DocDate>' ||
                '<RestrictionAnswerType>' || NVL(p_answer_type,'05') || '</RestrictionAnswerType>' ||
                '<LegalImpossibility>Ошибка формирования ответа: ' || SQLERRM || '</LegalImpossibility>' ||
                '</Report>'
            );
    END build_report_xml;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: П.1 — Проверка ЭП
    -- IMG_8022: если ЭП отсутствует/невалидна → StateId=90
    -- ============================================================
    PROCEDURE check_ep (
        p_ep_status  IN  VARCHAR2,
        p_errors     OUT t_error_tab,
        p_passed     OUT BOOLEAN
    ) IS
    BEGIN
        p_errors.DELETE;
        IF p_ep_status IS NULL OR UPPER(TRIM(p_ep_status)) != 'VALID' THEN
            push_error(
                p_errors,
                'ЭП',
                'Электронная подпись не прошла проверку',
                'EP_STATUS=' || NVL(p_ep_status,'NULL') || '; ожидается VALID'
            );
            p_passed := FALSE;
        ELSE
            p_passed := TRUE;
        END IF;
    END check_ep;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: П.2 — Проверка XSD (обязательные поля)
    -- IMG_8022: если реквизит отсутствует → StateId=91
    -- ============================================================
    PROCEDURE check_xsd (
        p_xml    IN  XMLTYPE,
        p_errors OUT t_error_tab,
        p_passed OUT BOOLEAN
    ) IS
        PROCEDURE xsd_chk (
            p_xpath   IN VARCHAR2,
            p_section IN VARCHAR2,
            p_field   IN VARCHAR2
        ) IS
            v_val VARCHAR2(4000);
        BEGIN
            v_val := get_xml_val(p_xml, p_xpath);
            IF v_val IS NULL THEN
                push_error(p_errors, p_section, p_field, 'XPath: ' || p_xpath);
            END IF;
        END xsd_chk;
    BEGIN
        p_errors.DELETE;

        -- Табл.9 — корневые обязательные поля Restrictn
        xsd_chk('string(/Restrictn/InternalKey)',    'Restrictn',    'InternalKey');
        xsd_chk('string(/Restrictn/DocDate)',        'Restrictn',    'DocDate');
        xsd_chk('string(/Restrictn/DocNum)',         'Restrictn',    'DocNum');
        xsd_chk('string(/Restrictn/DocCode)',        'Restrictn',    'DocCode');

        -- Табл.12 — обязательные поля IP
        xsd_chk('string(/Restrictn/IP/InternalKey)', 'Restrictn/IP', 'InternalKey');
        xsd_chk('string(/Restrictn/IP/IPNum)',        'Restrictn/IP', 'IPNum');
        xsd_chk('string(/Restrictn/IP/DebtorType)',   'Restrictn/IP', 'DebtorType');
        xsd_chk('string(/Restrictn/IP/DebtorName)',   'Restrictn/IP', 'DebtorName');
        xsd_chk('string(/Restrictn/IP/DebtorAdr)',    'Restrictn/IP', 'DebtorAdr');

        -- Табл.16 — ДУЛ (если блок присутствует)
        IF get_xml_val(p_xml, 'string(/Restrictn/Data/IdentificationData/TypeDoc)') IS NOT NULL
        OR get_xml_val(p_xml, 'string(/Restrictn/Data/IdentificationData/NumDoc)')  IS NOT NULL
        THEN
            xsd_chk('string(/Restrictn/Data/IdentificationData/TypeDoc)',
                    'IdentificationData', 'TypeDoc');
            xsd_chk('string(/Restrictn/Data/IdentificationData/NumDoc)',
                    'IdentificationData', 'NumDoc');
        END IF;

        -- Табл.17 — счёт (если блок присутствует)
        IF get_xml_val(p_xml, 'string(/Restrictn/Data/accountDatum/Acc)')     IS NOT NULL
        OR get_xml_val(p_xml, 'string(/Restrictn/Data/accountDatum/BicBank)') IS NOT NULL
        THEN
            xsd_chk('string(/Restrictn/Data/accountDatum/Acc)',
                    'accountDatum', 'Acc');
            xsd_chk('string(/Restrictn/Data/accountDatum/BicBank)',
                    'accountDatum', 'BicBank');
        END IF;

        p_passed := (p_errors.COUNT = 0);
    END check_xsd;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: П.3 — Форматно-логический контроль
    -- IMG_8022: ошибка формата → StateId=92
    -- Включает проверку Barcode (повторное исполнение)
    -- ============================================================
    PROCEDURE check_flc (
        p_xml          IN  XMLTYPE,
        p_internal_key IN  VARCHAR2,
        p_errors       OUT t_error_tab,
        p_passed       OUT BOOLEAN
    ) IS
        v_str    VARCHAR2(4000);
        v_num    NUMBER;
        v_date   DATE;
        v_s      VARCHAR2(4000);
        v_f      VARCHAR2(4000);

        PROCEDURE flc_err (p_sec VARCHAR2, p_fld VARCHAR2, p_det VARCHAR2) IS
        BEGIN
            push_error(p_errors, p_sec, p_fld, p_det);
        END flc_err;

    BEGIN
        p_errors.DELETE;

        -- DocDate: YYYY-MM-DD, не в будущем
        v_str := get_xml_val(p_xml, 'string(/Restrictn/DocDate)');
        IF v_str IS NOT NULL THEN
            BEGIN
                v_date := TO_DATE(v_str, C_DATE_FMT);
                IF v_date > SYSDATE + 1 THEN
                    flc_err('Restrictn','DocDate','Значение "'||v_str||'" — дата в будущем');
                END IF;
            EXCEPTION WHEN OTHERS THEN
                flc_err('Restrictn','DocDate','Значение "'||v_str||'" — неверный формат, ожидается YYYY-MM-DD');
            END;
        END IF;

        -- StartDate / FinDate: формат + FinDate >= StartDate
        v_s := get_xml_val(p_xml, 'string(/Restrictn/StartDate)');
        v_f := get_xml_val(p_xml, 'string(/Restrictn/FinDate)');
        IF v_s IS NOT NULL THEN
            BEGIN
                v_date := TO_DATE(v_s, C_DATE_FMT);
            EXCEPTION WHEN OTHERS THEN
                flc_err('Restrictn','StartDate','Значение "'||v_s||'" — неверный формат YYYY-MM-DD');
                v_s := NULL;
            END;
        END IF;
        IF v_f IS NOT NULL THEN
            BEGIN
                v_date := TO_DATE(v_f, C_DATE_FMT);
                IF v_s IS NOT NULL AND v_date < TO_DATE(v_s, C_DATE_FMT) THEN
                    flc_err('Restrictn','FinDate',
                        'FinDate ('||v_f||') < StartDate ('||v_s||')');
                END IF;
            EXCEPTION WHEN OTHERS THEN
                flc_err('Restrictn','FinDate','Значение "'||v_f||'" — неверный формат YYYY-MM-DD');
            END;
        END IF;

        -- Amount: число >= 0
        v_str := get_xml_val(p_xml, 'string(/Restrictn/Amount)');
        IF v_str IS NOT NULL THEN
            BEGIN
                v_num := TO_NUMBER(REPLACE(v_str,',','.'));
                IF v_num < 0 THEN
                    flc_err('Restrictn','Amount','Значение "'||v_str||'" — не может быть отрицательным');
                END IF;
            EXCEPTION WHEN VALUE_ERROR THEN
                flc_err('Restrictn','Amount','Значение "'||v_str||'" — не является числом');
            END;
        END IF;

        -- DebtorType: 1, 2 или 3
        v_str := get_xml_val(p_xml, 'string(/Restrictn/IP/DebtorType)');
        IF v_str IS NOT NULL AND v_str NOT IN ('1','2','3') THEN
            flc_err('Restrictn/IP','DebtorType',
                'Значение "'||v_str||'" — допустимы: 1=ЮЛ, 2=ФЛ, 3=ИП');
        END IF;

        -- BicBank: ровно 9 цифр
        v_str := get_xml_val(p_xml, 'string(/Restrictn/Data/accountDatum/BicBank)');
        IF v_str IS NOT NULL THEN
            IF LENGTH(TRIM(v_str)) != 9 OR REGEXP_LIKE(v_str,'[^0-9]') THEN
                flc_err('accountDatum','BicBank',
                    'Значение "'||v_str||'" — должен быть 9 цифр');
            END IF;
        END IF;

        -- Acc: ровно 20 цифр
        v_str := get_xml_val(p_xml, 'string(/Restrictn/Data/accountDatum/Acc)');
        IF v_str IS NOT NULL THEN
            IF LENGTH(TRIM(v_str)) != 20 OR REGEXP_LIKE(v_str,'[^0-9]') THEN
                flc_err('accountDatum','Acc',
                    'Значение "'||v_str||'" — должен быть 20 цифр');
            END IF;
        END IF;

        -- DebtorINN: 10 или 12 цифр
        v_str := get_xml_val(p_xml, 'string(/Restrictn/IP/DebtorINN)');
        IF v_str IS NOT NULL THEN
            IF LENGTH(TRIM(v_str)) NOT IN (10,12) OR REGEXP_LIKE(v_str,'[^0-9]') THEN
                flc_err('Restrictn/IP','DebtorINN',
                    'Значение "'||v_str||'" — должен быть 10 или 12 цифр');
            END IF;
        END IF;

        -- DebtorSnils: формат NNN-NNN-NNN NN
        v_str := get_xml_val(p_xml, 'string(/Restrictn/IP/DebtorSnils)');
        IF v_str IS NOT NULL THEN
            IF NOT REGEXP_LIKE(v_str,'^\d{3}-\d{3}-\d{3} \d{2}$') THEN
                flc_err('Restrictn/IP','DebtorSnils',
                    'Значение "'||v_str||'" — формат должен быть NNN-NNN-NNN NN');
            END IF;
        END IF;

        -- birthDate: YYYY-MM-DD, не в будущем, не старше 150 лет
        v_str := get_xml_val(p_xml,
            'string(/Restrictn/Data/IdentificationData/birthDate)');
        IF v_str IS NOT NULL THEN
            BEGIN
                v_date := TO_DATE(v_str, C_DATE_FMT);
                IF v_date > SYSDATE THEN
                    flc_err('IdentificationData','birthDate',
                        'Значение "'||v_str||'" — дата рождения в будущем');
                ELSIF v_date < SYSDATE - 365*150 THEN
                    flc_err('IdentificationData','birthDate',
                        'Значение "'||v_str||'" — некорректная дата рождения');
                END IF;
            EXCEPTION WHEN OTHERS THEN
                flc_err('IdentificationData','birthDate',
                    'Значение "'||v_str||'" — неверный формат YYYY-MM-DD');
            END;
        END IF;

        -- Barcode: 44 символа; число до дефиса = InternalKey
        -- IMG_8022: защита от повторного исполнения бумажного постановления
        v_str := get_xml_val(p_xml, 'string(/Restrictn/Barcode)');
        IF v_str IS NOT NULL THEN
            IF LENGTH(TRIM(v_str)) != 44 THEN
                flc_err('Restrictn','Barcode',
                    'Значение "'||v_str||'" — должен быть 44 символа');
            ELSE
                DECLARE
                    v_bc_key VARCHAR2(40);
                BEGIN
                    v_bc_key := SUBSTR(v_str, 1, INSTR(v_str,'-') - 1);
                    IF v_bc_key IS NOT NULL
                       AND p_internal_key IS NOT NULL
                       AND v_bc_key != p_internal_key
                    THEN
                        flc_err('Restrictn','Barcode',
                            'Число до дефиса ("'||v_bc_key
                            ||'") не совпадает с InternalKey ("'||p_internal_key
                            ||'") — возможно повторное исполнение');
                    END IF;
                END;
            END IF;
        END IF;

        p_passed := (p_errors.COUNT = 0);
    END check_flc;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: П.4 — Проверка дублей
    -- IMG_8022: найден дубль по InternalKey → StateId=94
    -- ============================================================
    PROCEDURE check_duplicate (
        p_xml      IN  XMLTYPE,
        p_doc_num  IN  VARCHAR2,
        p_errors   OUT t_error_tab,
        p_passed   OUT BOOLEAN
    ) IS
        v_xml_key    VARCHAR2(40);
        v_dup_docnum VARCHAR2(25);
    BEGIN
        p_errors.DELETE;

        v_xml_key := get_xml_val(p_xml, 'string(/Restrictn/InternalKey)');

        IF v_xml_key IS NOT NULL THEN
            BEGIN
                SELECT doc_num
                  INTO v_dup_docnum
                  FROM fssp_restrictions
                 WHERE internal_key = v_xml_key
                   AND doc_num     != p_doc_num
                   AND ROWNUM       = 1;

                -- Дубль найден
                push_error(
                    p_errors,
                    'Restrictn',
                    'InternalKey',
                    'Дубликат: InternalKey="'||v_xml_key
                        ||'" уже зарегистрирован под № "'||v_dup_docnum||'"'
                );
                p_passed := FALSE;
            EXCEPTION
                WHEN NO_DATA_FOUND THEN p_passed := TRUE;
            END;
        ELSE
            p_passed := TRUE;
        END IF;
    END check_duplicate;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: П.5 — Идентификация должника
    -- IMG_8022/8023: ни одного набора → RestrictionAnswerType=05
    -- ============================================================
    PROCEDURE check_debtor_id (
        p_xml    IN  XMLTYPE,
        p_errors OUT t_error_tab,
        p_passed OUT BOOLEAN
    ) IS
        v_inn   VARCHAR2(4000);
        v_snils VARCHAR2(4000);
        v_ser   VARCHAR2(4000);
        v_num   VARCHAR2(4000);
        v_bdt   VARCHAR2(4000);
        v_sur   VARCHAR2(4000);
        v_fnm   VARCHAR2(4000);
        v_found BOOLEAN := FALSE;
    BEGIN
        p_errors.DELETE;

        -- Набор 1: ИНН
        v_inn := NVL(
            get_xml_val(p_xml,'string(/Restrictn/IP/DebtorINN)'),
            get_xml_val(p_xml,'string(/Restrictn/Data/IdentificationData/INN)')
        );
        IF v_inn IS NOT NULL THEN v_found := TRUE; END IF;

        -- Набор 2: СНИЛС
        v_snils := get_xml_val(p_xml,'string(/Restrictn/IP/DebtorSnils)');
        IF v_snils IS NOT NULL THEN v_found := TRUE; END IF;

        -- Набор 3: Серия + номер паспорта + дата рождения
        v_ser := get_xml_val(p_xml,
            'string(/Restrictn/Data/IdentificationData/SerDoc)');
        v_num := get_xml_val(p_xml,
            'string(/Restrictn/Data/IdentificationData/NumDoc)');
        v_bdt := get_xml_val(p_xml,
            'string(/Restrictn/Data/IdentificationData/birthDate)');
        IF v_ser IS NOT NULL AND v_num IS NOT NULL AND v_bdt IS NOT NULL THEN
            v_found := TRUE;
        END IF;

        -- Набор 4: Фамилия + Имя
        v_sur := NVL(
            get_xml_val(p_xml,'string(/Restrictn/IP/DebtorFio/Surname)'),
            get_xml_val(p_xml,'string(/Restrictn/Data/IdentificationData/FIODoc/Surname)')
        );
        v_fnm := NVL(
            get_xml_val(p_xml,'string(/Restrictn/IP/DebtorFio/FirstName)'),
            get_xml_val(p_xml,'string(/Restrictn/Data/IdentificationData/FIODoc/FirstName)')
        );
        IF v_sur IS NOT NULL AND v_fnm IS NOT NULL THEN
            v_found := TRUE;
        END IF;

        IF NOT v_found THEN
            push_error(
                p_errors,
                'Идентификация должника',
                'Ни один набор не найден',
                'Проверено: ИНН='||NVL(v_inn,'NULL')
                    ||'; СНИЛС='||NVL(v_snils,'NULL')
                    ||'; Паспорт: SerDoc='||NVL(v_ser,'NULL')
                    ||' NumDoc='||NVL(v_num,'NULL')
                    ||' birthDate='||NVL(v_bdt,'NULL')
                    ||'; ФИО: Surname='||NVL(v_sur,'NULL')
                    ||' FirstName='||NVL(v_fnm,'NULL')
            );
        END IF;

        p_passed := v_found;
    END check_debtor_id;

    -- ============================================================
    -- ПРИВАТНАЯ ПРОЦЕДУРА: Специфические проверки по DocType
    -- IMG_8019, IMG_8020, IMG_8021
    -- ============================================================
    PROCEDURE check_by_doctype (
        p_xml      IN  XMLTYPE,
        p_doc_type IN  VARCHAR2,
        p_errors   OUT t_error_tab
    ) IS
        v_val VARCHAR2(4000);

        -- Проверяет поле и добавляет ошибку если пусто или не число > 0
        PROCEDURE need_field (p_sec VARCHAR2, p_fld VARCHAR2, p_xpath VARCHAR2) IS
            v_v VARCHAR2(4000);
        BEGIN
            v_v := get_xml_val(p_xml, p_xpath);
            IF v_v IS NULL THEN
                push_error(p_errors, p_sec, p_fld, 'Отсутствует; XPath: '||p_xpath);
            END IF;
        END need_field;

        -- Проверяет числовое поле > 0
        PROCEDURE need_amount (p_sec VARCHAR2, p_fld VARCHAR2, p_xpath VARCHAR2) IS
            v_v VARCHAR2(4000);
            v_n NUMBER;
        BEGIN
            v_v := get_xml_val(p_xml, p_xpath);
            IF v_v IS NULL THEN
                push_error(p_errors, p_sec, p_fld, 'Отсутствует (обязателен для данного типа)');
            ELSE
                BEGIN
                    v_n := TO_NUMBER(REPLACE(v_v,',','.'));
                    IF v_n <= 0 THEN
                        push_error(p_errors, p_sec, p_fld,
                            'Значение "'||v_v||'" должно быть > 0');
                    END IF;
                EXCEPTION WHEN VALUE_ERROR THEN
                    push_error(p_errors, p_sec, p_fld,
                        'Значение "'||v_v||'" не является числом');
                END;
            END IF;
        END need_amount;

        -- Проверяет RestrDocId + RestrDocDate (документы-основания)
        PROCEDURE need_ip_docs IS
            v_id   VARCHAR2(4000);
            v_dt   VARCHAR2(4000);
            v_date DATE;
        BEGIN
            v_id := get_xml_val(p_xml,'string(/Restrictn/RestrDocId)');
            v_dt := get_xml_val(p_xml,'string(/Restrictn/RestrDocDate)');
            IF v_id IS NULL THEN
                push_error(p_errors,'Restrictn(IPDocsInfo)','RestrDocId',
                    'Отсутствует ключ документа-основания');
            END IF;
            IF v_dt IS NULL THEN
                push_error(p_errors,'Restrictn(IPDocsInfo)','RestrDocDate',
                    'Отсутствует дата документа-основания');
            ELSE
                BEGIN
                    v_date := TO_DATE(v_dt, C_DATE_FMT);
                EXCEPTION WHEN OTHERS THEN
                    push_error(p_errors,'Restrictn(IPDocsInfo)','RestrDocDate',
                        'Значение "'||v_dt||'" — неверный формат YYYY-MM-DD');
                END;
            END IF;
        END need_ip_docs;

        -- Проверяет блок AvailabilityAccData (счёт)
        PROCEDURE need_acc IS
            v_acc VARCHAR2(4000);
            v_bic VARCHAR2(4000);
        BEGIN
            v_acc := get_xml_val(p_xml,'string(/Restrictn/Data/accountDatum/Acc)');
            v_bic := get_xml_val(p_xml,'string(/Restrictn/Data/accountDatum/BicBank)');
            IF v_acc IS NULL THEN
                push_error(p_errors,'accountDatum','Acc','Отсутствует номер счёта');
            ELSIF LENGTH(TRIM(v_acc)) != 20 OR REGEXP_LIKE(v_acc,'[^0-9]') THEN
                push_error(p_errors,'accountDatum','Acc',
                    'Значение "'||v_acc||'" — должен быть 20 цифр');
            END IF;
            IF v_bic IS NULL THEN
                push_error(p_errors,'accountDatum','BicBank','Отсутствует БИК');
            ELSIF LENGTH(TRIM(v_bic)) != 9 OR REGEXP_LIKE(v_bic,'[^0-9]') THEN
                push_error(p_errors,'accountDatum','BicBank',
                    'Значение "'||v_bic||'" — должен быть 9 цифр');
            END IF;
        END need_acc;

        -- Проверяет OspProperty (тип 9)
        PROCEDURE need_osp IS
            PROCEDURE o (p_fld VARCHAR2, p_xpath VARCHAR2,
                         p_len NUMBER DEFAULT NULL) IS
                v_v VARCHAR2(4000);
            BEGIN
                v_v := get_xml_val(p_xml, p_xpath);
                IF v_v IS NULL THEN
                    push_error(p_errors,'OspProperty',p_fld,'Отсутствует');
                ELSIF p_len IS NOT NULL AND LENGTH(TRIM(v_v)) != p_len THEN
                    push_error(p_errors,'OspProperty',p_fld,
                        'Значение "'||v_v||'" — ожидается длина '||p_len);
                END IF;
            END o;
        BEGIN
            o('OspCode',  'string(/Restrictn/OspProperty/OspCode)');
            o('RecpName', 'string(/Restrictn/OspProperty/RecpName)');
            o('RecpAdr',  'string(/Restrictn/OspProperty/RecpAdr)');
            o('RecpBank', 'string(/Restrictn/OspProperty/RecpBank)');
            o('RecpBIK',  'string(/Restrictn/OspProperty/RecpBIK)',  9);
            o('RecpINN',  'string(/Restrictn/OspProperty/RecpINN)');
            o('RecpKPP',  'string(/Restrictn/OspProperty/RecpKPP)',  9);
        END need_osp;

        -- Проверяет WageRetention
        PROCEDURE need_wage (p_full BOOLEAN DEFAULT TRUE) IS
            v_sdg VARCHAR2(4000);
            v_n   NUMBER;
        BEGIN
            need_field('WageRetention','OrderLivingWageAcc',
                'string(/Restrictn/WageRetention/OrderLivingWageAcc)');
            need_field('WageRetention','BankName',
                'string(/Restrictn/WageRetention/BankName)');
            -- SDGroupPopulation: 1-9
            v_sdg := get_xml_val(p_xml,
                'string(/Restrictn/WageRetention/SDGroupPopulation)');
            IF v_sdg IS NULL THEN
                push_error(p_errors,'WageRetention','SDGroupPopulation','Отсутствует');
            ELSE
                BEGIN
                    v_n := TO_NUMBER(v_sdg);
                    IF v_n NOT BETWEEN 1 AND 9 THEN
                        push_error(p_errors,'WageRetention','SDGroupPopulation',
                            'Значение "'||v_sdg||'" — допустимо 1-9');
                    END IF;
                EXCEPTION WHEN VALUE_ERROR THEN
                    push_error(p_errors,'WageRetention','SDGroupPopulation',
                        'Значение "'||v_sdg||'" — не является числом');
                END;
            END IF;
            IF p_full THEN
                need_field('WageRetention','BankBIK',
                    'string(/Restrictn/WageRetention/BankBIK)');
                need_field('WageRetention','Region',
                    'string(/Restrictn/WageRetention/Region)');
            END IF;
        END need_wage;

    BEGIN
        p_errors.DELETE;

        CASE p_doc_type
            -- Тип 1: только идентификация (уже проверена в П.5)
            WHEN 'O_IP_ACT_FIND_ACCOUNT'      THEN NULL;
            -- Тип 2: LimitSum + счёт
            WHEN 'O_IP_ACT_ARREST_ACCMONEY'   THEN
                need_amount('Restrictn','Amount','string(/Restrictn/Amount)');
                need_acc;
            -- Тип 3: документы-основания
            WHEN 'O_IP_ACT_ENDARREST'         THEN need_ip_docs;
            -- Тип 4: документы-основания + счёт + сумма
            WHEN 'O_IP_ACT_ENDARR_NO_CHANGE'  THEN
                need_ip_docs; need_acc;
                need_amount('Restrictn','Amount','string(/Restrictn/Amount)');
            -- Тип 5: LimitSum + счёт
            WHEN 'O_IP_ACT_GACCOUNT_MONEY'    THEN
                need_amount('Restrictn','Amount','string(/Restrictn/Amount)');
                need_acc;
            -- Тип 6: LimitSum + счёт
            WHEN 'O_IP_ACT_CURRENCY_ROUB'     THEN
                need_amount('Restrictn','Amount','string(/Restrictn/Amount)');
                need_acc;
            -- Тип 7: LimitSum + документы-основания + счёт
            WHEN 'O_IP_ACT_ENDARR_GMONEY'     THEN
                need_amount('Restrictn','Amount','string(/Restrictn/Amount)');
                need_ip_docs; need_acc;
            -- Тип 8: только RestrDocId
            WHEN 'O_IP_ACT_ENDGACCOUNT_MONEY' THEN
                need_field('Restrictn(IPDocsInfo)','RestrDocId',
                    'string(/Restrictn/RestrDocId)');
            -- Тип 9: OspProperty
            WHEN 'O_IP_ACT_EXECUTE'           THEN need_osp;
            -- Тип 10: WageRetention полный
            WHEN 'O_IP_ACT_LIVING_WAGE'       THEN need_wage(TRUE);
            -- Тип 11: WageRetention полный
            WHEN 'O_IP_ACT_CHNG_LIVING_WAGE'  THEN need_wage(TRUE);
            -- Тип 12: WageRetention без BankBIK+Region
            WHEN 'O_IP_ACT_END_LIVING_WAGE'   THEN need_wage(FALSE);
            ELSE
                push_error(p_errors,'DocType','Неизвестный тип',
                    'Значение: "'||NVL(p_doc_type,'NULL')||'"');
        END CASE;
    END check_by_doctype;

    -- ============================================================
    -- ПУБЛИЧНАЯ ПРОЦЕДУРА: основная точка входа
    -- Последовательность проверок по IMG_8022:
    --   П.1 → П.2 → П.3 → П.4 → П.5 → DocType
    -- Пп.1-4: критические → формируем Report и выходим
    -- П.5 + DocType: формируем Report с RestrictionAnswerType=05
    -- ============================================================
    PROCEDURE validate_and_report (
        p_doc_num    IN  VARCHAR2,
        p_report_xml OUT XMLTYPE,
        p_state_id   OUT VARCHAR2,
        p_message    OUT VARCHAR2
    ) IS
        v_xml          XMLTYPE;
        v_doc_type     VARCHAR2(50);
        v_internal_key VARCHAR2(40);
        v_ep_status    VARCHAR2(10);
        v_doc_num_xml  VARCHAR2(25);
        v_ip_key       VARCHAR2(40);
        v_doc_date     VARCHAR2(20);
        v_restr_num    VARCHAR2(25);
        v_restr_date   VARCHAR2(20);
        v_errors       t_error_tab;
        v_errors2      t_error_tab;
        v_passed       BOOLEAN;
        v_legal_imp    VARCHAR2(4000);
        v_answer_type  VARCHAR2(2);
        v_ext_key      VARCHAR2(60);
    BEGIN
        p_state_id   := NULL;
        p_message    := NULL;
        p_report_xml := NULL;

        -- ── 0. Читаем запись из таблицы ──────────────────────────
        BEGIN
            SELECT xml_restrictn, doc_type, internal_key, ep_status
              INTO v_xml, v_doc_type, v_internal_key, v_ep_status
              FROM fssp_restrictions
             WHERE doc_num = p_doc_num
               AND ROWNUM  = 1;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                -- Постановление не найдено → Report с кодом 07
                p_state_id   := C_ANS_NO_OBJECT;
                p_message    := 'Постановление "' || p_doc_num || '" не найдено';
                p_report_xml := build_report_xml(
                    p_restrictn_key  => NULL,
                    p_ip_key         => NULL,
                    p_doc_date       => TO_CHAR(SYSDATE, C_DATE_FMT),
                    p_restr_doc_num  => p_doc_num,
                    p_restr_doc_date => NULL,
                    p_answer_type    => C_ANS_NO_OBJECT,
                    p_legal_imp      => p_message,
                    p_external_key   => 'BANK-REPORT-NOTFOUND-' || p_doc_num
                );
                RETURN;
        END;

        -- Читаем ключевые поля из XML для формирования Report
        v_internal_key := NVL(v_internal_key,
            get_xml_val(v_xml,'string(/Restrictn/InternalKey)'));
        v_ip_key       := get_xml_val(v_xml,'string(/Restrictn/IP/InternalKey)');
        v_doc_date     := get_xml_val(v_xml,'string(/Restrictn/DocDate)');
        v_doc_num_xml  := get_xml_val(v_xml,'string(/Restrictn/DocNum)');
        v_restr_num    := get_xml_val(v_xml,'string(/Restrictn/RestrDocNumber)');
        v_restr_date   := get_xml_val(v_xml,'string(/Restrictn/RestrDocDate)');
        v_ext_key      := 'BANK-REPORT-' || NVL(p_doc_num,'X')
                          || '-' || TO_CHAR(SYSDATE,'YYYYMMDD-HH24MISS');

        -- ── П.1: Электронная подпись → StateId=90 ────────────────
        check_ep(v_ep_status, v_errors, v_passed);
        IF NOT v_passed THEN
            p_state_id   := C_STATE_BAD_SIGN;
            p_message    := 'П.1: ' || build_legal_impossibility(v_errors);
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => C_ANS_BAD_CONTENT,
                p_legal_imp      => SUBSTR('П.1 ЭП: ' || p_message, 1, 50)
                                    || ' | ' || p_message,
                p_external_key   => v_ext_key
            );
            RETURN;
        END IF;

        -- ── П.2: XSD → StateId=91 ────────────────────────────────
        check_xsd(v_xml, v_errors, v_passed);
        IF NOT v_passed THEN
            p_state_id   := C_STATE_BAD_XSD;
            p_message    := 'П.2: ' || build_legal_impossibility(v_errors);
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => C_ANS_BAD_CONTENT,
                p_legal_imp      => SUBSTR('П.2 XSD: ' || p_message, 1, 50)
                                    || ' | ' || p_message,
                p_external_key   => v_ext_key
            );
            RETURN;
        END IF;

        -- ── П.3: ФЛК → StateId=92 ────────────────────────────────
        check_flc(v_xml, v_internal_key, v_errors, v_passed);
        IF NOT v_passed THEN
            p_state_id   := C_STATE_BAD_FORMAT;
            p_message    := 'П.3: ' || build_legal_impossibility(v_errors);
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => C_ANS_BAD_CONTENT,
                p_legal_imp      => SUBSTR('П.3 ФЛК: ' || p_message, 1, 50)
                                    || ' | ' || p_message,
                p_external_key   => v_ext_key
            );
            RETURN;
        END IF;

        -- ── П.4: Дубль → StateId=94 ──────────────────────────────
        check_duplicate(v_xml, p_doc_num, v_errors, v_passed);
        IF NOT v_passed THEN
            p_state_id   := C_STATE_DUPLICATE;
            p_message    := 'П.4: ' || build_legal_impossibility(v_errors);
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => C_ANS_ALREADY_DONE,
                p_legal_imp      => SUBSTR('П.4 Дубль: ' || p_message, 1, 50)
                                    || ' | ' || p_message,
                p_external_key   => v_ext_key
            );
            RETURN;
        END IF;

        -- ── П.5: Идентификация + DocType → RestrictionAnswerType=05
        check_debtor_id(v_xml, v_errors, v_passed);
        check_by_doctype(v_xml, v_doc_type, v_errors2);

        -- Объединяем ошибки пп.5 и DocType
        IF v_errors.COUNT > 0 OR v_errors2.COUNT > 0 THEN
            -- Добавляем ошибки DocType к v_errors
            FOR i IN 1 .. v_errors2.COUNT LOOP
                push_error(v_errors,
                    v_errors2(i).section,
                    v_errors2(i).field,
                    v_errors2(i).detail);
            END LOOP;

            v_legal_imp  := build_legal_impossibility(v_errors);
            v_answer_type := C_ANS_BAD_CONTENT;
            p_state_id   := C_ANS_BAD_CONTENT;
            p_message    := 'Ошибки П.5/DocType: ' || v_legal_imp;
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => v_answer_type,
                p_legal_imp      => SUBSTR(v_legal_imp, 1, 50)
                                    || ' | ' || v_legal_imp,
                p_external_key   => v_ext_key
            );
        ELSE
            -- Все проверки пройдены
            p_state_id   := NULL;
            p_message    := 'OK: все проверки пройдены';
            p_report_xml := build_report_xml(
                p_restrictn_key  => v_internal_key,
                p_ip_key         => v_ip_key,
                p_doc_date       => NVL(v_doc_date, TO_CHAR(SYSDATE,C_DATE_FMT)),
                p_restr_doc_num  => NVL(v_restr_num, v_doc_num_xml),
                p_restr_doc_date => v_restr_date,
                p_answer_type    => '03',   -- исполнено
                p_legal_imp      => NULL,
                p_external_key   => v_ext_key
            );
        END IF;

        -- Сохраняем Report в таблицу
        BEGIN
            MERGE INTO fssp_reports tgt
            USING (SELECT p_doc_num AS doc_num FROM DUAL) src
               ON (tgt.doc_num = src.doc_num)
            WHEN MATCHED    THEN UPDATE SET xml_report = p_report_xml,
                                            created_at = SYSDATE
            WHEN NOT MATCHED THEN INSERT (doc_num, xml_report, created_at)
                                  VALUES (p_doc_num, p_report_xml, SYSDATE);
        EXCEPTION
            WHEN OTHERS THEN NULL; -- не блокируем если таблицы нет
        END;

    EXCEPTION
        WHEN OTHERS THEN
            p_state_id   := 'ERR';
            p_message    := 'Непредвиденная ошибка: ' || SQLCODE || ' / ' || SQLERRM;
            p_report_xml := build_report_xml(
                p_restrictn_key => NULL, p_ip_key => NULL,
                p_doc_date      => TO_CHAR(SYSDATE,C_DATE_FMT),
                p_restr_doc_num => p_doc_num, p_restr_doc_date => NULL,
                p_answer_type   => C_ANS_BAD_CONTENT,
                p_legal_imp     => SUBSTR(p_message, 1, 4000),
                p_external_key  => 'BANK-REPORT-ERR-' || p_doc_num
            );
            RAISE;
    END validate_and_report;

END pkg_fssp_validation;
/

-- ================================================================
-- Пример вызова:
--
--   SET SERVEROUTPUT ON SIZE UNLIMITED;
--   DECLARE
--       v_xml      XMLTYPE;
--       v_state_id VARCHAR2(5);
--       v_message  VARCHAR2(4000);
--   BEGIN
--       pkg_fssp_validation.validate_and_report(
--           p_doc_num    => '77001/24/123456',
--           p_report_xml => v_xml,
--           p_state_id   => v_state_id,
--           p_message    => v_message
--       );
--       DBMS_OUTPUT.PUT_LINE('StateId : ' || NVL(v_state_id, 'OK'));
--       DBMS_OUTPUT.PUT_LINE('Message : ' || v_message);
--       IF v_xml IS NOT NULL THEN
--           DBMS_OUTPUT.PUT_LINE('Report XML:');
--           DBMS_OUTPUT.PUT_LINE(v_xml.getClobVal());
--       END IF;
--   END;
--   /
-- ================================================================
