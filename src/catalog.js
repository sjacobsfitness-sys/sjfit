// Jacobs Fitness SKUs. The SKU is what Truemed pre-approves for HSA/FSA eligibility,
// so it must stay stable. Price is sent at purchase time and can change freely
// (length of commitment, bundles, a la carte, etc.).
//
// Send this list to Truemed (Lucas) so they can load these SKUs into the sandbox
// and production catalogs.
export const CATALOG = [
  { sku: 'SJF-MOVE-COACH', name: 'Online Movement Coaching' },
  { sku: 'SJF-NUTRITION-COACH', name: 'Health & Nutrition Coaching' },
  { sku: 'SJF-BLOODWORK-REVIEW', name: 'Blood Work Review' },
  { sku: 'SJF-INPERSON-SESSION', name: 'In-Person Training Session' },
];

export function findItem(sku) {
  return CATALOG.find((item) => item.sku === sku);
}
