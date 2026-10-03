const demoColors = {
  p1: ['Gold'], p2: ['Gold'], p3: ['Red', 'Green'], p4: ['Blue'],
  p5: ['Gold', 'Pearl'], p6: ['Gold'], p7: ['Gold'], p8: ['Green'],
  p9: ['Pearl'], p10: ['Blue'], p11: ['Blue'], p15: ['Silver']
};

export function defaultSizes(category) {
  return category === 'Bangles' ? ['42', '44', '46', '48']
    : category === 'Earrings' ? ['One size'] : ['Free size'];
}

export function productColors(product) {
  return Array.isArray(product.colors) && product.colors.length ? product.colors : demoColors[product.id] || ['Gold'];
}

export function productSizes(product) {
  if (Array.isArray(product.sizes) && product.sizes.length) return product.sizes;
  if (product.category === 'Bangles') return defaultSizes('Bangles');
  return product.size ? [product.size] : defaultSizes(product.category);
}

export function optionList(value, fallback, label) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.length || value.length > 12) throw Object.assign(new Error(`Add 1–12 ${label}.`), {status: 400});
  const list = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (list.some(item => !item || item.length > 30) || new Set(list.map(item => item.toLocaleLowerCase('en'))).size !== list.length) {
    throw Object.assign(new Error(`Use unique ${label}, each up to 30 characters.`), {status: 400});
  }
  return list;
}

export function withOptions(product) {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  const onSale = product.oldPrice > product.price && (!product.saleStart || product.saleStart <= today) && (!product.saleEnd || product.saleEnd >= today);
  return {
    ...product,
    colors: productColors(product),
    sizes: productSizes(product),
    images: Array.isArray(product.images) && product.images.length ? product.images : [product.image],
    stock: product.stock && typeof product.stock === 'object' ? product.stock : {},
    status: product.status || 'live',
    displayPrice: onSale ? product.price : (product.oldPrice > product.price ? product.oldPrice : product.price),
    onSale
  };
}

export const stockKey = (color, size) => JSON.stringify([color, size]);

export function variantStock(product, color, size) {
  const value = product.stock?.[stockKey(color, size)];
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function hasStock(product) {
  return productColors(product).some(color => productSizes(product).some(size => variantStock(product, color, size) > 0));
}
