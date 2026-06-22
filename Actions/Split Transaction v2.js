/**
 * @trigger-type manual
 * @trigger-version 1
 * @trigger-cooldown 0
 * @trigger-lockable true
 * @trigger-manual-allowed true
 * @trigger-show-in-ui true
 *
 * @metadata {text} split_field - optional - Field to split on <custom.delivery_address>
 * @metadata {text} module - optional - Module <SALES>
 * @metadata {text} submodule - optional - Submodule <ORDER>
 * @metadata {text} document_type - optional - Document Type <SALES_ORDER>
 */

const handle = async (providedData) => {
  const { payload } = providedData;
  const metadata = _.get(payload, "metadata", {});

  const splitField = _.get(metadata, "split_field", "custom.delivery_address");
  const module = _.get(metadata, "module", "SALES");
  const submodule = _.get(metadata, "submodule", "ORDER");
  const documentType = _.get(metadata, "document_type", "SALES_ORDER");

  const model = _.get(payload, "resource.model");
  const uuid = _.get(payload, "resource.uuid");

  if (!model || !uuid) {
    logger.warn("Missing model or uuid");
    return;
  }

  const zmodel = await Model.load(payload.resource);
  const data = zmodel.data();

  logger.info("Data", data);

  // Check if order is already split
  logger.info("Is Split Field?", _.get(data, "custom.is_split"));
  if (_.get(data, "custom.is_split") === "T") {
    logger.error("Order is already split");
    return;
  }

  const customerUuid = _.get(data, "customer.uuid");
  let customerDefaultAddress = null;

  const mapToCustomerDefaultAddress = (address) => {
    if (!address) return null;
    let countryCode = _.get(address, "country__code");
    if (countryCode == null) {
      countryCode = _.get(address, "country.code");
    }
    return {
      addressee: _.get(address, "addressee"),
      attention: _.get(address, "attention"),
      address_line_1: _.get(address, "address_line_1"),
      address_line_2: _.get(address, "address_line_2"),
      city: _.get(address, "city"),
      state: _.get(address, "state"),
      postcode: _.get(address, "postcode"),
      country_code: countryCode,
    };
  };

  const getAddressFromCustomerSearch = (customer) => {
    if (!customer) return null;
    const addresses = _.get(customer, "addresses");
    return _.isArray(addresses) ? _.head(addresses) || null : addresses || null;
  };

  if (customerUuid) {
    const addressSearch = await Zudello.search({
      model: "Address",
      filter: {
        customer__uuid: customerUuid,
      },
      select: [
        "uuid",
        "addressee",
        "attention",
        "address_line_1",
        "address_line_2",
        "city",
        "state",
        "postcode",
        "country__code",
      ],
      limit: 1,
    });
    logger.info("Customer Address Search Result", addressSearch);
    customerDefaultAddress = mapToCustomerDefaultAddress(
      _.get(addressSearch, "data.data[0]"),
    );

    if (!customerDefaultAddress) {
      const customerSearch = await Zudello.search({
        model: "Customer",
        filter: { uuid: customerUuid },
        select: [
          "uuid",
          "addresses__uuid",
          "addresses__addressee",
          "addresses__attention",
          "addresses__address_line_1",
          "addresses__address_line_2",
          "addresses__city",
          "addresses__state",
          "addresses__postcode",
          "addresses__country__code",
        ],
        limit: 1,
      });
      logger.info("Customer fallback search result", customerSearch);
      const customer = _.get(customerSearch, "data.data[0]");
      customerDefaultAddress = mapToCustomerDefaultAddress(
        getAddressFromCustomerSearch(customer),
      );
    }

    if (customerDefaultAddress) {
      logger.info("Customer default address", customerDefaultAddress);
    } else {
      logger.warn(
        "No address found for customer " +
          customerUuid +
          "; no default address available",
      );
    }
  } else {
    logger.info("No customer on transaction; no default address available");
  }

  // Parse a comma-separated delivery address string into its 6 positional components.
  // Expected order: addressee, street address, suburb, city, postcode, country.
  // The suburb (position 3) maps to address_line_2, and the following field
  // maps to city. There is no state in the delivery-address string.
  // Empty positions are preserved (e.g. "AGB Stone Wellington, 22 Barnes St, Seaview, Wellington, , ").
  const parseDeliveryAddress = (addressString) => {
    if (!addressString || typeof addressString !== "string") {
      return null;
    }
    const parts = addressString.split(",").map((p) => p.trim());
    // Pad to 6 positions in case extraction returned fewer commas than expected
    while (parts.length < 6) parts.push("");
    return {
      addressee: parts[0] || null,
      address_line_1: parts[1] || null,
      address_line_2: parts[2] || null, // suburb
      city: parts[3] || null,
      postcode: parts[4] || null,
      country_name: parts[5] || null,
    };
  };

  const formatDeliveryAddress = (addr) => {
    if (!addr) return null;
    const parts = [
      addr.addressee,
      addr.address_line_1,
      addr.address_line_2, // suburb
      addr.city,
      addr.postcode,
      addr.country_code,
    ].map((p) => (p == null ? "" : String(p).trim()));
    if (!parts.some((p) => p)) return null;
    return parts.join(", ");
  };

  const buildLineCustom = (line) => {
    const lineCustom = { ..._.get(line, "custom", {}) };
    const delivery = _.get(line, splitField);
    if (delivery != null && String(delivery).trim() !== "") {
      return lineCustom;
    }
    const formatted = customerDefaultAddress
      ? formatDeliveryAddress(customerDefaultAddress)
      : null;
    if (formatted) {
      lineCustom.delivery_address = formatted;
    }
    return lineCustom;
  };

  // A parsed address is considered "useful" only if it has at least one real
  // location component. An addressee-only result (e.g. parsing "Back Order ")
  // is not a delivery address and should trigger the customer-default fallback.
  const hasUsefulAddress = (parsed) => {
    if (!parsed) return false;
    return !!(
      parsed.address_line_1 ||
      parsed.address_line_2 ||
      parsed.city ||
      parsed.postcode
    );
  };

  // Group lines by split field value
  const lines = _.get(data, "lines", []);
  const uniqueValues = _.uniq(_.map(lines, splitField));
  if (uniqueValues.length <= 1) {
    logger.info(
      "All lines have the same value for " + splitField + ", cannot split",
    );
    return;
  }
  const lineGroups = _.groupBy(lines, splitField);
  logger.info("Line groups", lineGroups);

  // For each group of lines, create a new document with the same header data but only those lines
  let isFirst = true;
  let splitIndex = 0;
  const createData = _.map(lineGroups, (groupLines, splitValue) => {
    const splitLetter = String.fromCharCode(97 + splitIndex); // a, b, c, ...
    const lineTotal = _.sumBy(groupLines, (l) => parseFloat(l.total) || 0);
    const lineTax = _.sumBy(groupLines, (l) => parseFloat(l.tax) || 0);

    const deliveryAddressString =
      splitField === "custom.delivery_address"
        ? splitValue
        : _.get(groupLines, "[0].custom.delivery_address");
    const parsedAddress = parseDeliveryAddress(deliveryAddressString);
    logger.info("Parsed address for split " + splitLetter, parsedAddress);

    const useCustomerDefault = !hasUsefulAddress(parsedAddress);

    // Resolve the address for this split STRICTLY from the line/parsed address
    // (preferred) or, when the line has no usable address, the customer's
    // default address. The original document header is deliberately never used
    // as a source, so a split can never inherit header address values.
    //
    // Every field the chosen source does not supply is set to null. Combined
    // with clear_nulls on the write, null clears the field on the resulting
    // document rather than leaving whatever was previously there.
    const resolvedAddress = useCustomerDefault
      ? {
          addressee: _.get(customerDefaultAddress, "addressee") || null,
          attention: _.get(customerDefaultAddress, "attention") || null,
          address_line_1:
            _.get(customerDefaultAddress, "address_line_1") || null,
          address_line_2:
            _.get(customerDefaultAddress, "address_line_2") || null,
          city: _.get(customerDefaultAddress, "city") || null,
          state: _.get(customerDefaultAddress, "state") || null,
          postcode: _.get(customerDefaultAddress, "postcode") || null,
          country_code: _.get(customerDefaultAddress, "country_code") || null,
        }
      : {
          addressee: _.get(parsedAddress, "addressee") || null,
          // The delivery-address string carries no attention,
          // so it is cleared rather than inherited from the header.
          attention: null,
          address_line_1: _.get(parsedAddress, "address_line_1") || null,
          // The suburb (position 3 of the delivery string) maps to line 2.
          address_line_2: _.get(parsedAddress, "address_line_2") || null,
          city: _.get(parsedAddress, "city") || null,
          // The delivery string carries no state, so it is cleared rather than
          // inherited from the header.
          state: null,
          postcode: _.get(parsedAddress, "postcode") || null,
          // The parsed string yields only a country *name*, never the code the
          // country fetch needs, so fall back to the customer's country (NOT the
          // document's). Null if the customer has no default address on file.
          country_code: _.get(customerDefaultAddress, "country_code") || null,
        };

    const resolvedCountryCode = resolvedAddress.country_code;

    const result = {
      model: "Transaction",
      data: {
        module,
        submodule,
        document_type: documentType,
        document_number:
          _.get(data, "document_number") + " (" + splitLetter + ")",
        status: "READY",
        date_issued: _.get(data, "date_issued"),
        date_due: _.get(data, "date_due"),
        reference: _.get(data, "reference"),
        addressee: resolvedAddress.addressee,
        attention: resolvedAddress.attention,
        address_line_1: resolvedAddress.address_line_1,
        address_line_2: resolvedAddress.address_line_2,
        city: resolvedAddress.city,
        state: resolvedAddress.state,
        postcode: resolvedAddress.postcode,
        total: lineTotal,
        tax: lineTax,
        country: resolvedCountryCode && {
          fetch: true,
          data: {
            code: resolvedCountryCode,
          },
        },
        currency: _.get(data, "currency.uuid") && {
          fetch: true,
          data: {
            uuid: _.get(data, "currency.uuid"),
          },
        },
        customer: _.get(data, "customer.uuid") && {
          fetch: true,
          data: {
            uuid: _.get(data, "customer.uuid"),
          },
        },
        custom: {
          is_split: "T",
          ...(isFirst
            ? {
                Netsuite_freight_amount: _.get(
                  data,
                  "custom.Netsuite_freight_amount",
                  0,
                ),
              }
            : { Netsuite_freight_amount: 0 }), // If is first set freight amount, otherwise set to 0
        },
        related_resources: {
          replace: true,
          items: [
            {
              fetch: true,
              model: "Transaction",
              data: {
                uuid: uuid,
              },
            },
          ],
        },
        lines: {
          replace: true,
          items: _.map(groupLines, (line) => ({
            data: {
              description: _.get(line, "description"),
              project: _.get(line, "project.uuid") && {
                fetch: true,
                data: {
                  uuid: _.get(line, "project.uuid"),
                },
              },
              quantity: _.get(line, "quantity"),
              custom: buildLineCustom(line),
              sku: _.get(line, "sku"),
              item: _.get(line, "item.uuid") && {
                fetch: true,
                data: {
                  uuid: _.get(line, "item.uuid"),
                },
              },
              unit_price: _.get(line, "unit_price"),
              retail_price: _.get(line, "retail_price"),
              tax: _.get(line, "tax"),
              total: _.get(line, "total"),
            },
            create: true,
            update: true,
          })),
        },
      },
      enrich: false,
      submit: false,
      create: true,
      update: true,
      update_status: false,
    };
    isFirst = false;
    splitIndex++;
    return result;
  });

  // Archive the original document
  createData.push({
    model: "Transaction",
    data: {
      uuid: uuid,
      status: "ARCHIVED",
    },
    update: true,
  });

  logger.info("Payload", createData);
  //return;

  // The explicit nulls above are cleared by Zudello's default clear_nulls
  // behaviour on updateOrCreate, so nothing carries over from whatever was
  // previously on the document. No extra options are passed here.
  const result = await Zudello.updateOrCreate({ data: createData });
  logger.info("Result", result);

  if (result?.success) {
    const zudStatus = _.get(result, "data.status");
    if (zudStatus === "partial" || zudStatus === "failure") {
      const resources = _.get(result, "data.resources", []);
      const failedResources = resources.filter((resource) => !resource.success);
      logger.error("Failed resources:", failedResources);
    }
  } else {
    logger.error("Error received from Zudello:", result);
  }
};