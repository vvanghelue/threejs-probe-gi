// Scene registry: the first entry is the default, `?scene=<id>` picks another one.
import campus from './campus.js';
import cloister from './cloister.js';

export const SCENES = [campus, cloister];
export const pickScene = (id) => SCENES.find((s) => s.id === id) ?? SCENES[0];
