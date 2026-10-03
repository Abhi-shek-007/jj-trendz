export const defaultCheckout = {
  upiId: '8015743250@nyes',
  payeeName: 'ABHISHEK S',
  deliveryFee: 0
};

export const defaultHeroCopy = {
  eyebrow: 'THE EVERYDAY SPARKLE EDIT',
  headline: 'A little sparkle.',
  highlight: 'A lot of you.',
  description: 'For the everyday moments and the unforgettable ones. Discover jewellery that feels like you.'
};

export const validUpiId = value => /^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(value);

export function upiUri({upiId, payeeName, amount, reference, orderId}) {
  if (!validUpiId(upiId) || !payeeName || !Number.isInteger(amount) || amount < 1 || !/^\d{1,35}$/.test(reference)) throw new Error('Invalid UPI payment details.');
  const fields = [
    ['pa', upiId], ['pn', payeeName], ['tr', reference],
    ['tn', `JJ TrendZ order ${orderId.slice(0, 8).toUpperCase()}`],
    ['am', amount.toFixed(2)], ['cu', 'INR']
  ];
  return `upi://pay?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}
