const handle = async (providedData) => {
  // Extract Data
  const { payload } = providedData;

  const model = _.get(payload, "resource.model");
  const uuid = _.get(payload, "resource.uuid");

  if (!model || !uuid) {
    logger.warn("Missing model or uuid");
    return;
  }

  const fetchedItem = await Zudello.fetch({ model, uuid });
  const zmodel = await Model.load(payload.resource);
  const data = zmodel.data();

  logger.info("Data", data);

  // Check if this is an update (external_id exists) or create
  const existingExternalId = _.get(data, "external_id");
  const isUpdate = !!existingExternalId;

  logger.info(isUpdate ? "Updating existing order" : "Creating new order", {
    existingExternalId,
  });

  const lines = _.get(data, "lines");
  logger.info("Lines", lines);

  // Extract notes for internal notes field
  const notes = _.get(data, "notes", []);
  const notesText = _.map(notes, (note) => _.get(note, "body", ""))
    .filter(Boolean)
    .join("\n\n");

  // If no notes, fall back to customer shipping notes
  const internalNotes =
    notesText || _.get(data, "customer.custom.shippingNotes", "");

  const orderReceivedDateTime = moment(_.get(data, "created_at") || new Date());
  const orderReceivedDate = orderReceivedDateTime.format("DD/MM/YYYY");
  const orderReceivedTime = orderReceivedDateTime.format("hh:mm A");

  logger.info("Internal Notes", internalNotes);

  const formatCountry = (country) => {
    if (!country) return undefined;
    return "_" + _.camelCase(country);
  };

  // Shipping Address
  const shippingAddress = {
    addressee: _.get(data, "addressee"),
    attention: _.get(data, "attention"),
    addr1: _.get(data, "address_line_1") || "",
    addr2: _.get(data, "address_line_2") || "",
    addr3: _.get(data, "address_line_3") || "",
    zip: _.get(data, "postcode"),
    company_phone: _.get(data, "phone"),
    city: _.get(data, "city"),
    state: _.get(data, "state"),
    country: formatCountry(_.get(data, "country.name")),
    override: false,
  };

  logger.info("Shipping Address", shippingAddress);
  //return;

  // Payload Construction
  const body = {
    ...(isUpdate && { internalId: existingExternalId }),
    tranId: _.get(data, "document_number"),
    entity: _.get(data, "customer.external_id"),
    externalId: _.get(data, "uuid"),
    tranDate: misc.formatDate(_.get(data, "date_due"), "YYYY-MM-DD"),
    memo: _.get(data, "reference") || "",
    otherRefNum: _.get(data, "document_number"),
    //shipDate: misc.formatDate(_.get(data, "date_due"), "YYYY-MM-DD"),
    //billingAddress: shippingAddress,
    shippingAddress: shippingAddress,
    shippingCost: _.get(data, "custom.Netsuite_freight_amount", 0),
    customForm: { id: "180" },
    orderStatus: "_pendingFulfillment",
    customFieldList: {
      customField: [
        {
          scriptId: "custbodyorderplacedby",
          value: { internalId: "104" }, // Zudello
        },
        {
          scriptId: "custbody_internalnotes",
          value: internalNotes,
        },
        {
          scriptId: "custentity_internalmemo",
          value: _.get(data, "custom.internal_memo"),
        },
        {
          scriptId: "custbody_order_received_method",
          value: { internalId: "1" }, // Email order
        },
        {
          scriptId: "custbody_order_received_date",
          value: orderReceivedDate,
        },
        {
          scriptId: "custbody_order_received_time",
          value: orderReceivedTime,
        },
        {
          type: "BooleanCustomFieldRef",
          scriptId: "custbody_is_final_order",
          value: true,
        },
        {
          type: "BooleanCustomFieldRef",
          scriptId: "custbody_is_split_order",
          value: _.get(data, "custom.Is_Split") === "T",
        },
        {
          type: "SelectCustomFieldRef",
          scriptId: "custbody1",
          value: { internalId: "251895" }, // Employee - Zudello
        },
        {
          scriptId: "custbody_zudello_document_link",
          value: _.get(fetchedItem, "data.short_url"),
        },
      ],
    },
  };

  const items = _.map(lines, (line, index) => ({
    item: _.get(line, "item.external_id"),
    line: index + 1,
    quantity: _.get(line, "quantity"),
    location: _.get(line, "location.external_id"),
    //rate: 0,
    //amount:  0,
    customFieldList: {
      customField: [
        {
          scriptId: "custcol_f3_job_reference",
          value: _.get(line, "custom.job_number"),
        },
      ],
    },
  }));

  _.set(body, "itemList", { item: items, replaceAll: false });

  const requestData = {
    url: isUpdate
      ? `transactions/SalesOrder/${existingExternalId}`
      : "transactions/SalesOrder",
    method: "POST",
    body: body,
  };
  logger.info("Request Data", requestData);
  //return;

  // Send Payload to destination
  const response = await NetsuiteSOAP.universal.request(requestData);
  logger.info("Response", response);

  // Handle Errors
  const isSuccessful = _.get(response, "data.writeResponse.status.isSuccess");
  const statusDetailMessages = _.compact(
    _.map(
      _.filter(_.get(response, "data.writeResponse.status.statusDetail", []), {
        type: "ERROR",
      }),
      (detail) => _.get(detail, "message"),
    ),
  );

  const errorMessages = _.compact(
    _.map(_.get(response, "error.messages", []), (msg) =>
      _.get(msg, "error.message"),
    ),
  );
  const errorMessage =
    [...statusDetailMessages, ...errorMessages].join(" AND ") ||
    "Unknown error creating sales order";

  if (!isSuccessful) {
    logger.error("Netsuite Error", errorMessage);

    await zmodel.fail({
      message: errorMessage,
      external_id: existingExternalId,
      exit: true,
    });
  }

  const external_id = _.get(response, "data.writeResponse.baseRef.internalId");

  logger.success(
    isUpdate ? "Order Updated" : "Order Created",
    `Sales order ${isUpdate ? "updated" : "created"} successfully: ${external_id}`,
  );

  await zmodel.complete({
    external_id,
    properties: {
      log_messages: { replace: true, items: [] },
    },
  });

  //return; // Attachment logic requires SDK change.

  // Attach PDF if present
  const folderId = metadata.get("attachmentFolderId", "6329249");
  logger.info("Folder ID for attachment", folderId);
  if (!external_id || !folderId) return;
  logger.info("Checking for file attachment to attach to sales order", {
    external_id,
    folderId,
  });

  const fileAttachment = await Zudello.getFileAttachment({
    uuid,
    type: "EXTRACTED",
  });
  if (!_.get(fileAttachment, "success")) {
    logger.warn("No file attachment found to attach");
    return;
  }

  const fileData = _.get(fileAttachment, "data");

  const attachBody = {
    internalId: external_id,
    s3Url: fileData,
    folderId: folderId,
    type: "salesOrder",
  };

  logger.info("Attachment Body", attachBody);

  const attachResponse = await NetsuiteSOAP.attach.upload(attachBody);

  logger.info("Attachment Response", attachResponse);

  if (_.get(attachResponse, "success")) {
    logger.info("File attached", _.get(attachResponse, "data"));
  } else {
    zmodel.fail({ message: "Failed to attach file" });
    logger.error("Failed to attach file", _.get(attachResponse, "error"));
  }
};
