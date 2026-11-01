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
  /** Brief section 6: the property part of the landing fee, by level (base, 2, 3), in % of the original price. */
  levelFeePercent: [100, 150, 200],
  /** Brief section 7: a station costs the property's original price to build. */
  stationCostPercent: 100,
  /** Brief sections 6-7: a station adds half of its build cost to the landing fee. */
  stationFeeAddOnPercent: 50,
  /** Brief section 8: rent is 10% of the original price, paid by the tenant to the owner each lap. */
  rentPercent: 10,
} as const;
