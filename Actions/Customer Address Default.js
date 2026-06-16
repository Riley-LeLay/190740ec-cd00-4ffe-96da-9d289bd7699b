/**
 * @trigger-type manual
 * @trigger-version 1
 * @trigger-cooldown 0
 * @trigger-lockable true
 * @trigger-manual-allowed true
 * @trigger-show-in-ui true
 *
 * Checks whether a delivery/shipping address is set on a Sales Order header.
 * If no usable address is present, it falls back to the customer's default
 * address (looked up via the Address model, then the Customer model) and
 * writes those values back onto the transaction header.
 */

const handle = async (providedData) => {
  const { payload } = providedData;

  const model = _.get(payload, "resource.model");
  const uuid = _.get(payload, "resource.uuid");

  if (!model || !uuid) {
    logger.warn("Missing model or uuid");
    return;
  }

  const zmodel = await Model.load(payload.resource);
  const data = zmodel.data();

  logger.info("Data", data);

 // --- Determine whether the header already has a usable address -----------
  // The order is considered to have an address if address_line_1 is present.
  // We only fall back to the customer default when it is missing
  // (null / empty / whitespace).
  const isBlank = (v) => v == null || String(v).trim() === "";

  const headerMissingAddress =
    isBlank(_.get(data, "address_line_1"));

  if (!headerMissingAddress) {
    logger.info(
      "Sales order already has address_line_1; no default required",
    );
    return;
  }

  logger.info("No usable address on sales order; resolving customer default");

  // --- Resolve the customer's default address ------------------------------
  // Identical mapping + search approach to the split script.
  const customerUuid = _.get(data, "customer.uuid");
  if (!customerUuid) {
    logger.warn("No customer on transaction; cannot resolve a default address");
    return;
  }

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
      address_line_3: _.get(address, "address_line_3"),
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

  let customerDefaultAddress = null;

  // Primary lookup: Address model filtered by customer.
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
      "address_line_3",
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

  // Fallback lookup: Customer model with nested addresses.
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
        "addresses__address_line_3",
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

  if (!customerDefaultAddress) {
    logger.warn(
      "No address found for customer " +
        customerUuid +
        "; nothing to default",
    );
    return;
  }

  logger.info("Customer default address", customerDefaultAddress);

  // --- Build the header update --------------------------------------------
  // Only set fields the customer default actually provides; keep header
  // values for anything the default is missing.
  const resolvedCountryCode =
    _.get(customerDefaultAddress, "country_code") ||
    _.get(data, "country.code");

  const headerUpdate = {
    model: "Transaction",
    data: {
      uuid: uuid,
      addressee:
        _.get(customerDefaultAddress, "addressee") || _.get(data, "addressee"),
      attention:
        _.get(customerDefaultAddress, "attention") || _.get(data, "attention"),
      address_line_1:
        _.get(customerDefaultAddress, "address_line_1") ||
        _.get(data, "address_line_1"),
      address_line_2:
        _.get(customerDefaultAddress, "address_line_2") ||
        _.get(data, "address_line_2"),
      address_line_3:
        _.get(customerDefaultAddress, "address_line_3") ||
        _.get(data, "address_line_3"),
      city: _.get(customerDefaultAddress, "city") || _.get(data, "city"),
      state: _.get(customerDefaultAddress, "state") || _.get(data, "state"),
      postcode:
        _.get(customerDefaultAddress, "postcode") || _.get(data, "postcode"),
      country: resolvedCountryCode && {
        fetch: true,
        data: {
          code: resolvedCountryCode,
        },
      },
    },
    enrich: false,
    submit: false,
    update: true,
    update_status: false,
  };

  logger.info("Header update payload", headerUpdate);
  // return;

  const result = await Zudello.updateOrCreate({ data: [headerUpdate] });
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
