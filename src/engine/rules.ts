// Approved numbers from the project brief. Change them only when the brief changes.
export const RULES = {
  minPlayers: 2,
  maxPlayers: 6,
  startingCash: 20000,
  gateBonus: 10000,
  /** Brief section 6: each development step costs 50% of the original price. */
  developmentCostPercent: 50,
  /** Brief section 6: highest level is 3 (base = 1, then 2, then 3). */
  maxLevel: 3,
  /**
   * The property part of the landing fee, by level (base, 2, 3), in % of the original price.
   * Owner decision (replaces the brief's 100% / 150% / 200%).
   */
  levelFeePercent: [10, 20, 30],
  /** Brief section 7: a station costs the property's original price to build. */
  stationCostPercent: 100,
  /**
   * A station adds this % of its build cost (= the property's original price) to the landing fee.
   * Owner decision: 5% (replaces the brief's "half of the build cost").
   */
  stationFeeAddOnPercent: 5,
  /** Rent paid by the tenant to the owner each lap, in % of the original price. Owner decision: 50% (brief: 10%). */
  rentPercent: 50,
} as const;
