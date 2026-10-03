import {withOptions} from './variants.mjs';

export const initialProducts = [
{id:'p1',name:'The Golden Twist Hoops',category:'Earrings',price:799,oldPrice:0,image:'/assets/hero.jpg',caption:'A little twist on your everyday favourites. Pair these warm golden hoops with everything from a crisp shirt to your favourite festive outfit.',badge:'EVERYDAY FAVOURITE',collection:'Everyday'},
{id:'p2',name:'Daisy Layered Necklace',category:'Necklaces',price:1299,oldPrice:0,image:'/assets/jewel-1.jpg',caption:'Delicate layers, a floral touch, and effortless charm. A lovely finishing touch for the moments you make your own.',badge:'NEW ARRIVAL',collection:'Everyday',size:'Free size'},
{id:'p3',name:'Heritage Bridal Set',category:'Bridal Sets',price:6499,oldPrice:0,image:'/assets/bridal-set.jpg',caption:'A statement bridal necklace, matching earrings and maang tikka with rich ruby and emerald accents. A complete look for your special day.',badge:'OCCASION EDIT',collection:'Occasion',included:'Necklace, matching earrings and maang tikka'},
{id:'p4',name:'Sapphire Bloom Drops',category:'Earrings',price:1499,oldPrice:0,image:'/assets/jewel-4.jpg',caption:'Blue-toned statement earrings with a beautifully detailed surround. Made for dressing up and standing out.',badge:'FESTIVE PICK',collection:'Festive'},
{id:'p5',name:'Pearl Bloom Open Bangles',category:'Bangles',price:1799,oldPrice:0,image:'/assets/bangles.jpg',caption:'A pair of floral gold-tone open cuffs with pearl details. Choose your preferred bangle size for a graceful festive look.',badge:'NEW ARRIVAL',collection:'Festive',size:'Free size',included:'Pair of bangles'}];
initialProducts.push(...[
['p6','Pearl Dew Necklace','Necklaces',1199,'necklace-gold.jpg','Everyday'],
['p7','Celeste Layered Necklace','Necklaces',1699,'jewel-1.jpg','Occasion'],
['p8','Emerald Heritage Necklace','Necklaces',2199,'necklace-pendant.jpg','Festive'],
['p9','Luna Twist Earrings','Earrings',699,'earrings-pearl.jpg','Everyday'],
['p10','Aurora Blue Earrings','Earrings',1299,'earrings-gold.jpg','Occasion'],
['p11','Blue Royal Drops','Earrings',1899,'jewel-4.jpg','Festive'],
['p15','Crystal Halo Pendant','Necklaces',1799,'necklace-pendant.jpg','Occasion']
].map(([id,name,category,price,photo,collection])=>({id,name,category,price,oldPrice:0,image:'/assets/'+photo,collection,badge:'NEW ARRIVAL',size:category==='Necklaces'?'Free size':undefined,caption:'A beautifully styled addition to your jewellery collection. Ask us about materials and availability before ordering.'})));
for (let index = 0; index < initialProducts.length; index++) {
  const {size, ...product} = withOptions(initialProducts[index]);
  initialProducts[index] = {...product, occasion: product.collection === 'Festive' ? 'Festive' : product.collection === 'Occasion' ? 'Wedding' : 'Daily wear'};
}
