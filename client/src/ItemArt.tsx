import { Accessory } from './PixelCreature.js';
import type { PreviewAccessory } from './pets-preview-data.js';

export const accessoryForItem: Record<string, PreviewAccessory> = { 'trail-bandana': 'bandana', 'daisy-pin': 'bell', 'mushroom-cap': 'leaf', 'moon-scarf': 'scarf', 'star-medal': 'star', 'explorer-hat': 'leaf', 'flower-crown': 'leaf', 'round-glasses': 'star' };
export function ItemArt({ itemId }: { itemId: string }) {
  return <svg className="item-art" viewBox="-12 -12 24 28" shapeRendering="crispEdges" aria-hidden="true"><Accessory item={accessoryForItem[itemId] || 'star'}/></svg>;
}
