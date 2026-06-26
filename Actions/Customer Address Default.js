/**
 * @trigger-type manual
 * @trigger-version 1
 * @trigger-cooldown 0
 * @trigger-lockable true
 * @trigger-manual-allowed true
 * @trigger-show-in-ui true
 *
 * Checks whether a delivery/shipping address is set on a Sales Order header.
 *
 * Case 1 – address_line_1 is missing:
 *   Falls back to the customer's default address and writes all available
 *   fields onto the transaction header (merging with any existing values).
 *
 * Case 2 – address_line_1 is present but addressee / address_line_3 / city /
 *   postcode is blank:
 *   Looks up the customer's default address. If its address_line_1 matches
 *   the header's address_line_1 (case-insensitive trim), replaces the entire
 *   address with the customer default. If it does not match, does nothing.
 */

const handle = async (providedData) => {
  const { payload } = providedData;

  const model = _.get(payload, "resource.model");
  const uuid  = _.get(payload, "resource.uuid");

  if (!model || !uuid) {
    logger.warn("Missing model or uuid");
    return;
  }

  const zmodel = await Model.load(payload.resource);
  const data   = zmodel.data();

  logger.info("Data", data);

  // -------------------------------------------------------------------------
  // Determine which scenario applies
  // -------------------------------------------------------------------------
  const isBlank = (v) => v == null || String(v).trim() === "";

  const headerMissingAddress = isBlank(_.get(data, "address_line_1"));

  const headerHasIncompleteAddress =
    !headerMissingAddress &&
    (
      isBlank(_.get(data, "addressee"))      ||
      isBlank(_.get(data, "address_line_3")) ||
      isBlank(_.get(data, "city"))           ||
      isBlank(_.get(data, "postcode"))
    );

  if (!headerMissingAddress && !headerHasIncompleteAddress) {
    logger.info("Sales order already has a complete address; no default required");
    return;
  }

  if (headerMissingAddress) {
    logger.info("No usable address on sales order; resolving customer default");
  } else {
    logger.info(
      "Sales order address is incomplete (addressee / address_line_3 / city / postcode); " +
      "checking customer default for potential replacement"
    );
  }

  // -------------------------------------------------------------------------
  // Resolve the customer's default address (shared lookup logic)
  // -------------------------------------------------------------------------
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
      addressee:     _.get(address, "addressee"),
      attention:     _.get(address, "attention"),
      address_line_1: _.get(address, "address_line_1"),
      address_line_2: _.get(address, "address_line_2"),
      address_line_3: _.get(address, "address_line_3"),
      city:          _.get(address, "city"),
      state:         _.get(address, "state"),
      postcode:      _.get(address, "postcode"),
      country_code:  countryCode,
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
    filter: { customer__uuid: customerUuid },
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
      "No address found for customer " + customerUuid + "; nothing to default",
    );
    return;
  }

  logger.info("Customer default address", customerDefaultAddress);

  // -------------------------------------------------------------------------
  // Case 2: header already has address_line_1 — compare with customer default
  // -------------------------------------------------------------------------
  if (headerHasIncompleteAddress) {
    const headerLine1  = String(_.get(data, "address_line_1") || "").trim().toLowerCase();
    const defaultLine1 = String(_.get(customerDefaultAddress, "address_line_1") || "").trim().toLowerCase();

    if (headerLine1 !== defaultLine1) {
      logger.info(
        "Header address_line_1 does not match customer default address_line_1; no update applied",
      );
      return;
    }

    logger.info(
      "Header address_line_1 matches customer default; replacing entire address with customer default",
    );
  }

  // -------------------------------------------------------------------------
  // Build the header update
  //
  // Case 1 (missing address_line_1): merge customer default with existing
  //   header values so any partial data already present is preserved.
  // Case 2 (incomplete but line 1 matched): replace entirely with the
  //   customer default — no fallback to the existing header values.
  // -------------------------------------------------------------------------
  let addressFields;

  if (headerMissingAddress) {
    // Merge: customer default takes priority; keep existing header value as
    // fallback for any field the customer default does not supply.
    addressFields = {
      addressee:      _.get(customerDefaultAddress, "addressee")      || _.get(data, "addressee"),
      attention:      _.get(customerDefaultAddress, "attention")      || _.get(data, "attention"),
      address_line_1: _.get(customerDefaultAddress, "address_line_1") || _.get(data, "address_line_1"),
      address_line_2: _.get(customerDefaultAddress, "address_line_2") || _.get(data, "address_line_2"),
      address_line_3: _.get(customerDefaultAddress, "address_line_3") || _.get(data, "address_line_3"),
      city:           _.get(customerDefaultAddress, "city")           || _.get(data, "city"),
      state:          _.get(customerDefaultAddress, "state")          || _.get(data, "state"),
      postcode:       _.get(customerDefaultAddress, "postcode")       || _.get(data, "postcode"),
    };
  } else {
    // Full replacement: use customer default values only.
    addressFields = {
      addressee:      _.get(customerDefaultAddress, "addressee"),
      attention:      _.get(customerDefaultAddress, "attention"),
      address_line_1: _.get(customerDefaultAddress, "address_line_1"),
      address_line_2: _.get(customerDefaultAddress, "address_line_2"),
      address_line_3: _.get(customerDefaultAddress, "address_line_3"),
      city:           _.get(customerDefaultAddress, "city"),
      state:          _.get(customerDefaultAddress, "state"),
      postcode:       _.get(customerDefaultAddress, "postcode"),
    };
  }

  const resolvedCountryCode =
    _.get(customerDefaultAddress, "country_code") ||
    (headerMissingAddress ? _.get(data, "country.code") : null);

  const headerUpdate = {
    model: "Transaction",
    data: {
      uuid: uuid,
      ...addressFields,
      country: resolvedCountryCode && {
        fetch: true,
        data: { code: resolvedCountryCode },
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
      const resources      = _.get(result, "data.resources", []);
      const failedResources = resources.filter((resource) => !resource.success);
      logger.error("Failed resources:", failedResources);
    }
  } else {
    logger.error("Error received from Zudello:", result); 
  }
};