/** Context supplied to every adapter for a parse operation. */
export interface VenueContext {
  /** ISO 10383 MIC (e.g. "XNYS", "XHKG"). */
  mic: string;
  /** Instrument category the venue trades (e.g. "stock", "commodity_future"). */
  instrument_category: string;
  /** Key referencing the CDM profile to validate against. */
  profile_reference: string;
}

/**
 * A single instrument record normalized from a venue snapshot.
 *
 * Carries core identity fields, the primary cross-reference identifier (ISIN),
 * and any venue-specific attributes the CDM assembler will need.
 */
export interface NormalizedRecord {
  /** Venue-native ticker symbol. */
  venue_symbol: string;
  /** ISO 6166 ISIN. */
  isin: string;
  /** Human-readable instrument name. */
  instrument_name: string;
  /** ISO 4217 currency code. */
  currency: string;
  /** Asset class of the instrument (e.g. "stock"). */
  asset_class: string;
  /** ISO 10383 MIC of the trading venue. */
  mic: string;
  /**
   * Arbitrary venue-specific attributes (e.g. board lot, tick size).
   * The CDM assembler uses these to populate extension fields and listings.
   */
  attributes: Record<string, string>;
  /** Option-specific: strike price (e.g. "600.00"). */
  strike_price?: string;
  /** Option-specific: expiration date ISO 8601 (e.g. "2025-12-19"). */
  expiration_date?: string;
  /** Option-specific: put or call (e.g. "call"). */
  put_call?: string;
  /** Option-specific: ISIN of the underlier instrument. */
  underlier_isin?: string;
  /** Option-specific: exercise style (e.g. "american"). */
  option_style?: string;
  /** Option-specific: contract multiplier (e.g. "100"). */
  contract_multiplier?: string;
}
