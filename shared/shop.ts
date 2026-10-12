import type { EquipmentSlot, Outfit, Pet } from './types.js';

export type ShopItem = { id: string; name: string; slot: EquipmentSlot; price: number; color: string; description: string };
export const shopItems: ShopItem[] = [
  { id: 'trail-bandana', name: 'Bandana', slot: 'neck', price: 0, color: '#cf877b', description: 'A copper knot for the road.' },
  { id: 'daisy-pin', name: 'Bell', slot: 'badge', price: 0, color: '#d8bd78', description: 'A tiny chime. Good company.' },
  { id: 'mushroom-cap', name: 'Leaf cap', slot: 'head', price: 120, color: '#91a86c', description: 'Shelter under a little leaf.' },
  { id: 'moon-scarf', name: 'Scarf', slot: 'neck', price: 140, color: '#a2bacb', description: 'Something soft for a cool evening.' },
  { id: 'star-medal', name: 'Star pin', slot: 'badge', price: 90, color: '#dfc481', description: 'A pocket-sized piece of sky.' },
];
export type ShopState = { catalog: ShopItem[]; pet: Pet; points: number; ownedItems: string[]; equippedItems: Outfit };
export const shopState = (pet: Pet): ShopState => ({ catalog: shopItems, pet, points: pet.points || 0, ownedItems: pet.ownedItems || [], equippedItems: pet.equippedItems || {} });
