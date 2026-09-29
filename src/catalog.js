// Jacobs Fitness SKUs. The SKU is what Truemed pre-approves for HSA/FSA eligibility,
// so it must stay stable. Price is sent at purchase time and can change freely
// (length of commitment, bundles, a la carte, etc.).
//
// These are the SKUs registered with Truemed.
export const CATALOG = [
  {
    sku: 'inperson-training',
    name: 'Private In-Person Training Sessions',
    description:
      '1:1 in-person exercise training: individualized strength, mobility, and movement training, supervised by a certified strength and conditioning specialist',
  },
  {
    sku: 'online-training',
    name: 'Online Coaching: Training',
    description:
      '1:1 remote fitness coaching: individualized exercise programming for strength and mobility, with regular check-ins and movement review',
  },
  {
    sku: 'online-nutrition',
    name: 'Online Coaching: Nutrition',
    description: '1:1 remote nutrition coaching: individualized nutrition guidance and habit coaching, with regular check-ins',
  },
  {
    sku: 'online-hybrid',
    name: 'Online Coaching: Training + Nutrition',
    description:
      '1:1 remote fitness and nutrition coaching: individualized exercise programming and nutrition guidance, with regular check-ins',
  },
];

export function findItem(sku) {
  return CATALOG.find((item) => item.sku === sku);
}
