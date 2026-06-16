/**
 * @trigger-type scheduled
 * @trigger-schedule 0 * * * *
 * @trigger-version 1
 * @trigger-cooldown 0
 * @trigger-connection netsuite
 * @trigger-lockable true
 * @trigger-manual-allowed true
 * @trigger-show-in-ui true
 */

const handle = async (providedData) => {
  const lastModified = metadata.getDateTime(
    "lastModified",
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD",
    "2026-04-01 00:00:00",
  );

  let where = "";
  if (lastModified) {
    where = `WHERE c.lastmodifieddate > TO_DATE('${lastModified}', 'YYYY-MM-DD HH24:MI:SS')`;
  }

  logger.info("Last Modified", lastModified);

  // --- Sanitisers for garbage values coming from NetSuite -------------------
  const isGarbage = (value) => {
    if (value === null || value === undefined) return true;
    const cleaned = String(value).trim();
    if (cleaned === "") return true;
    // Pure punctuation/whitespace placeholders: ****, ...., ----, ___, etc.
    if (/^[*.#?\-_\s]+$/.test(cleaned)) return true;
    // Excel error values
    if (/^#(REF|N\/A|VALUE|NAME|NULL|DIV\/0|NUM)!?$/i.test(cleaned)) return true;
    return false;
  };

  const cleanString = (value) => {
    if (isGarbage(value)) return undefined;
    return String(value).trim();
  };

  const cleanZip = (value) => cleanString(value);

  const cleanPhone = (value) => {
    if (isGarbage(value)) return undefined;
    const stripped = String(value).replace(/[-\s]/g, "");
    // Reject phone numbers that are all zeros or obvious placeholders
    if (/^0+$/.test(stripped)) return undefined;
    if (/^(0{6,}|4000000000)$/.test(stripped)) return undefined;
    return stripped;
  };

  const cleanEmail = (value) => {
    if (isGarbage(value)) return undefined;
    const cleaned = String(value).trim();
    // Basic sanity check - must contain @ and a dot
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return undefined;
    // Reject known placeholder emails
    if (/^(dunno|test|placeholder|none)@/i.test(cleaned)) return undefined;
    return cleaned;
  };
  // --------------------------------------------------------------------------

  const customerFields = `c.id, c.entityid, c.companyname, c.email AS customer_email, c.phone AS customer_phone, c.isinactive, TO_CHAR(c.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS lastmodifieddate, c.vatregnumber, c.terms, c.custentitycustentity_grade, c.custentity_internalmemo`;
  const contactFields = `co.email AS contact_email, co.phone AS contact_phone, co.firstname AS contact_firstname, co.lastname AS contact_lastname`;
  const addressFields = `ea.addr1, ea.addr2, ea.addr3, ea.addressee, ea.attention, ea.city, ea.state, ea.zip, ea.country, ea.addrphone, ea.addrtext`;
  const query = `SELECT ${customerFields}, ${contactFields}, ${addressFields} FROM Customer c LEFT JOIN Contact co ON co.company = c.id LEFT JOIN CustomerAddressbookEntityAddress ea ON c.defaultshippingaddress = ea.nkey ${where} ORDER BY c.lastmodifieddate ASC, c.id ASC`;
  logger.info("Netsuite Query", query);

  for await (const items of Netsuite.universal.autoPaginationList({
    query,
    offset: 0,
    limit: 1000,
  })) {
    logger.info("Netsuite Fetch Customers", items);

    if (items?.data?.status?.items.length === 0) {
      logger.error("Error fetching customers from NetSuite", items);
      return;
    }

    const grouped = _.groupBy(_.sortBy(items?.data?.items, "id"), "id");
    const sortedData = _.map(grouped, (rows) => ({
      ...rows[0],
      emails: _.uniq(
        _.compact(
          _.flatMap(rows, (r) => [
            cleanEmail(r.customer_email),
            cleanEmail(r.contact_email),
          ]),
        ),
      ),
      phones: _.uniq(
        _.compact(
          _.flatMap(rows, (r) => [
            cleanPhone(r.customer_phone),
            cleanPhone(r.contact_phone),
          ]),
        ),
      ),
    }));
    logger.info("Zudello Parse Customers", sortedData);
    //return;

    const data = _.map(sortedData, (item) => {
      const zip = cleanZip(_.get(item, "zip"));
      const addressee = cleanString(_.get(item, "addressee"));
      const addr1 = cleanString(_.get(item, "addr1"));
      const addr2 = cleanString(_.get(item, "addr2"));
      const addr3 = cleanString(_.get(item, "addr3"));
      const city = cleanString(_.get(item, "city"));
      const state = cleanString(_.get(item, "state"));
      const country = cleanString(_.get(item, "country"));

      return {
        external_id: _.get(item, "id"),
        code: _.get(item, "entityid"),
        legal_name: _.get(item, "companyname"),
        tax_number: _.get(item, "vatregnumber"),
        trading_name: _.get(item, "companyname"),
        status: _.get(item, "isinactive") === "T" ? "INACTIVE" : "ACTIVE",
        addresses: {
          replace: true,
          items: [
            {
              create: true,
              data: {
                ...(addressee && { addressee }),
                ...(addr1 && { address_line_1: addr1 }),
                ...(addr2 && { address_line_2: addr2 }),
                ...(addr3 && { address_line_3: addr3 }),
                ...(city && { city }),
                ...(state && { state }),
                ...(zip && { postcode: zip }),
                ...(country && {
                  country: {
                    fetch: true,
                    create: false,
                    update: false,
                    data: {
                      code: country,
                    },
                  },
                }),
              },
            },
          ],
        },
        ...(_.get(item, "terms") && {
          payment_term: {
            fetch: true,
            update: false,
            create: false,
            data: {
              external_id: _.get(item, "terms"),
            },
          },
        }),
        ...(item.emails.length > 0 && {
          emails: {
            replace: true,
            items: _.map(item.emails, (email) => ({
              create: true,
              data: {
                email,
              },
            })),
          },
        }),
        ...(item.phones.length > 0 && {
          phones: {
            replace: true,
            items: _.map(item.phones, (phone) => ({
              create: true,
              data: {
                phone,
              },
            })),
          },
        }),
        custom: {
          pricing_tier: _.get(item, "custentitycustentity_grade"),
          internal_memo: _.get(item, "custentity_internalmemo"),
        },
      };
    });

    logger.info("Zudello Parse Customers", data);
    //return;

    const result = await Zudello.customer.updateOrCreate({ data });

    logger.info("Zudello Response", result);

    if (result?.success) {
      const zudStatus = _.get(result, "data.status");
      if (zudStatus === "partial" || zudStatus === "failure") {
        logger.error("Error received from Zudello:", result);
        return;
      }
      const lastObject = _.last(items?.data?.items);
      const updatedLastModified = lastObject
        ? lastObject.lastmodifieddate
        : null;
      if (updatedLastModified) {
        metadata.set("lastModified", updatedLastModified);
        logger.info("Updated lastModified", updatedLastModified);
      }
    } else {
      logger.error("Error received from Zudello:", result);
      return;
    }
  }
};
