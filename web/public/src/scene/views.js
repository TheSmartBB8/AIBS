// views.js — the fixed review viewpoints.
//
// Held constant so every iteration of a visual review compares the same framing: a shot
// that drifted would make "did this get better?" unanswerable.
//
// They live in their own module rather than in main.js so tests can import them without
// pulling in the DOM. tests/scene.test.mjs asserts every one of these stands in open air
// in the built level — a camera that ends up inside geometry renders a dark slab and
// wastes a whole screenshot round trip before anyone notices why.
//
// The ground surface is at y = 1.2 m (groundY 12 x VOXEL), so a standing eye is at 2.9 m.
// These used to sit at 1.8-1.9 m — knee height on the road — which put a third of every
// frame under tarmac and hid the buildings' upper storeys behind their own eaves.
export const VIEWS = {
  // On the road looking down it: shopfronts to one side, the warehouse to the other.
  street:   { pos: [2.6,  2.9,  3.4], look: [22.0, 3.4,  4.8], fov: 70 },
  approach: { pos: [2.2,  2.9,  6.0], look: [13.0, 4.0, 13.0], fov: 72 },
  // Back down the lane toward the warehouse. Pulled in from x 21.5: the box van parks
  // across the full width of the road from there.
  corner:   { pos: [18.5, 2.9,  3.0], look: [11.0, 4.2, 12.5], fov: 66 },
  wide:     { pos: [1.6,  7.0,  1.0], look: [14.0, 2.6, 13.5], fov: 62 },
  interior: { pos: [12.5, 2.9, 15.5], look: [12.2, 3.2,  8.5], fov: 76 },
  closeup:  { pos: [10.4, 2.2,  6.2], look: [11.6, 2.6,  8.0], fov: 52 },
  container:{ pos: [24.4, 2.9,  5.2], look: [21.0, 2.4, 11.5], fov: 66 },
  aerial:   { pos: [2.0, 19.0,  2.0], look: [13.0, 1.0, 13.0], fov: 60 },
  // Down the street the other way, so the backdrop and the far end are in frame. Kept
  // hard against the kerb: out in the lane it stood inside the parked van.
  reverse:  { pos: [23.0, 2.9,  2.15], look: [2.0, 3.4, 3.6], fov: 70 },
};
