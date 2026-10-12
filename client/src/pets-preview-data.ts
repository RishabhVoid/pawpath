export type PreviewCreature = {
  id: string;
  name: string;
  kind: string;
  color: string;
  file: string;
  size: [number, number];
  frames: number[][];
  neck: [number, number];
  head: [number, number];
  flying?: boolean;
};

export const previewCreatures: PreviewCreature[] = [
  { id: 'pip', name: 'Pip', kind: 'Slug hare', color: '#d4cdb6', file: 'simple-trail', size: [1374, 1145], frames: [[32,50,272,204],[378,50,272,204],[708,50,272,204],[1053,51,272,204]], neck: [46,42], head: [46,23] },
  { id: 'cinder', name: 'Cinder', kind: 'Newt hound', color: '#b87952', file: 'simple-trail', size: [1374, 1145], frames: [[26,316,305,145],[361,316,305,145],[693,316,305,145],[1040,316,305,145]], neck: [49,51], head: [49,39] },
  { id: 'moss', name: 'Moss', kind: 'Sprout frog', color: '#85956a', file: 'simple-trail', size: [1374, 1145], frames: [[96,503,179,188],[444,502,179,188],[784,505,179,188],[1115,505,179,188]], neck: [47,49], head: [44,34] },
  { id: 'puddle', name: 'Puddle', kind: 'Gill otter', color: '#aaa1be', file: 'simple-trail', size: [1374, 1145], frames: [[32,734,303,151],[366,734,303,151],[702,734,303,151],[1042,734,303,151]], neck: [49,52], head: [48,41] },
  { id: 'reed', name: 'Reed', kind: 'Marsh strider', color: '#6894a3', file: 'simple-trail', size: [1374, 1145], frames: [[33,913,282,198],[374,913,282,198],[723,913,282,198],[1061,913,282,198]], neck: [46,39], head: [46,26] },
  { id: 'bramble', name: 'Bramble', kind: 'Briar mouse', color: '#bd9398', file: 'simple-wild', size: [1145, 1374], frames: [[42,52,235,236],[312,52,235,236],[583,52,235,236],[876,52,235,236]], neck: [46,45], head: [45,33] },
  { id: 'wisp', name: 'Wisp', kind: 'Moth owl', color: '#cbbb85', file: 'simple-wild', size: [1145, 1374], frames: [[54,327,216,213],[322,327,216,213],[597,327,216,213],[894,327,216,213]], neck: [44,43], head: [44,26], flying: true },
  { id: 'dew', name: 'Dew', kind: 'Shell dragon', color: '#74a8a5', file: 'simple-wild', size: [1145, 1374], frames: [[42,572,231,227],[320,572,231,227],[595,572,231,227],[890,572,231,227]], neck: [47,43], head: [47,30] },
  { id: 'truffle', name: 'Truffle', kind: 'Beetle boar', color: '#b47561', file: 'simple-wild', size: [1145, 1374], frames: [[42,869,236,168],[324,870,236,168],[596,870,236,168],[886,870,236,168]], neck: [47,51], head: [46,39] },
  { id: 'drift', name: 'Drift', kind: 'Kite ray', color: '#a9c6d6', file: 'simple-wild', size: [1145, 1374], frames: [[30,1058,267,218],[293,1048,267,218],[556,1070,267,218],[847,1070,267,218]], neck: [48,43], head: [47,32], flying: true },
];

export const previewAccessories = [
  { id: 'bandana', name: 'Bandana' },
  { id: 'bell', name: 'Bell' },
  { id: 'leaf', name: 'Leaf cap' },
  { id: 'scarf', name: 'Scarf' },
  { id: 'star', name: 'Star pin' },
] as const;
export type PreviewAccessory = typeof previewAccessories[number]['id'];
