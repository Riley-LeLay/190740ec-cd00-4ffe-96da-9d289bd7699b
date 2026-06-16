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
  const lastModified = metadata.get("lastModified");
  let where = "";
  if (lastModified) {
    where = `WHERE lastmodifieddate >= '${lastModified}'`;
  }

  // HAVE ANOTHER CRACK TOMORROW
  const query = `SELECT id, itemid, displayname, purchasedescription, lastpurchaseprice, description, unitstype, itemType, isinactive, subsidiary, lastmodifieddate FROM item ${where} ORDER BY lastmodifieddate ASC, id ASC`;
  // id, itemid, purchasedescription, lastpurchaseprice, description, unitstype, itemType, isinactive, subsidiary, lastmodifieddate
  logger.info("Netsuite Query", query);

  // let count = 0;

  // const amount_query = `SELECT COUNT(*) as count FROM item ${where}`;
  // const amount_result = await Netsuite.universal.list({ query: amount_query });
  // logger.info("Count Query Result:", amount_result);
  // const check_amount = _.get(amount_result, "data.items[0].count");
  // logger.info("Parsed Count:", check_amount);

  // const collected_items = [];
  // const offeset_limit = 1000;
  // for (let offset = 0; offset < check_amount; offset += offeset_limit) {
  //   const test = await Netsuite.universal.list({ offset, limit: offeset_limit, query: query });
  //   count += _.get(test, "data.items", []).length;
  //   collected_items.push(..._.get(test, "data.items", []));
  //   logger.info(`Fetched batch at offset ${offset}, count`, count);
  // }

  // logger.info(`Netsuite Collected Items ${collected_items.length}`, collected_items);
  // logger.info("Netsuite Count Query", check_amount);
  // logger.info("Netsuite Test List Count", count);
  // return;

  for await (const items of Netsuite.universal.autoPaginationList({
    query,
    offset: 0,
    limit: 100, // 100
  })) {
    logger.info("Items", items);
    //return;

    const data = _.map(items?.data?.items, (item) => {
      const description = (
        _.get(item, "displayname") ||
        _.get(item, "purchasedescription") ||
        _.get(item, "description") ||
        _.get(item, "itemid")
      ).slice(0, 255);

      const baseItem = {
        document_type: "ITEM",
        module: "INVENTORY",
        submodule: "CATALOGUE",
        external_id: _.get(item, "id"),
        sku: _.get(item, "itemid"),
        description: description,
        short_description: description,
        status: _.get(item, "isinactive") === "F" ? "ACTIVE" : "INACTIVE",
      };

      const lastPurchasePrice = _.get(item, "lastpurchaseprice");
      if (lastPurchasePrice) {
        baseItem.purchase_price = lastPurchasePrice;
      }

      return baseItem;
    });

    logger.info("Zudello Parse Items", data);

    const result = await Zudello.item.updateOrCreate({ data });

    logger.info("Zudello Response", result);
    // return;

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
      }
      await checkpoint.save();
    } else {
      logger.error("Error received from Zudello:", result);
      return;
    }
  }
};
