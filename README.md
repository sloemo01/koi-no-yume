<div align="center">

# koi no yume

A pixel-art koi pond that runs in the browser. Raw WebGL 2, jQuery for the ripples, MIT licensed.

Every koi, lily pad, flower, dragonfly and rowboat is painted pixel by pixel at runtime. Nothing is loaded as a sprite sheet, and the whole scene renders into a small buffer that is stretched back up, so it keeps hard pixel edges at any window size.

[![MIT](https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square)](LICENSE)
[![no build step](https://img.shields.io/badge/build-none-a06a2c?style=flat-square)](index.html)
[![WebGL 2](https://img.shields.io/badge/renderer-WebGL%202-3a5d8f?style=flat-square)](src/gfx.js)

<img src="docs/hero.png" alt="The pond at sunset, with a rowboat drifting among koi, lily pads and flowering lotus" width="100%">

</div>

## The pond

The water fills the whole frame. There is no bank in view, just pond, with the floor shelving up toward the edges and the deep sitting under the middle. Leave it alone and the koi drift on their own, mostly high in the water, now and then dipping into the cool and staying down a while.

Click the surface and rings spread out, and every koi turns and rises to circle the spot. Drag a lily pad and it pushes real waves, then rides the swell back home. Throw it and it skims across the water and slides past whatever it meets. The rowboat works the same way, and it goes around the stepping stones rather than through them.

### Get it

Play it at **[koi-no-yume.vercel.app](https://koi-no-yume.vercel.app)**, or run it yourself. There is no build step and nothing to install, jQuery is vendored in the repo.

```bash
git clone https://github.com/sloemo01/koi-no-yume.git
cd koi-no-yume
python3 -m http.server 4173
```

Then open <http://localhost:4173>. Any static server works just as well, and opening `index.html` straight off the disk works too.

Prefer a download? On the repo page choose **Code**, then **Download ZIP**, unzip it anywhere, and open `index.html`.

## Moods

Six moods, each one a different sky, a different quality of light on the water, and its own glints.

| Mood | What it does |
| --- | --- |
| Sunny | warm sky, strong glints, sharp cloud shade |
| Clear | cooler and even, the quietest of the six |
| Mist | haze gathered at the top, the near water stays sharp |
| Sunset | orange over violet, low warm light, long gold glints |
| Moonlight | moon white over deep blue, cool glints, a heavier bloom |
| Rain | moonlight's palette with weather on it: drops, impact rings, heavier cloud shade |

## Controls

| Input | What it does |
| --- | --- |
| Click or tap the water | a ripple, and the koi come up and circle it |
| Drag a lily pad | pushes waves; let go fast and it skims |
| Drag the boat | it follows the hand and glides when you let go |
| Shift click | drops food pellets; the koi break off to eat |
| `space` | scatter the shoal |
| `[` `]` | fewer or more koi |
| `1` `2` `3` | pixel size |
| `d` | draw the procedural spines |
| `f` | food at the middle |
| `h` | hide the interface |
| `r` | a brand new pond |
| `s` | sound on or off |

On a phone or tablet the bar lays itself out as a grid, the keyboard hints drop away, and both panels dock to the bottom of the screen. Hiding the interface leaves a three line tab at the top right, which is the way back.

## What lives in the pond

Six koi varieties, four of each by default: kohaku and sanke in bold red wraps with sumi spots, showa on black with red and white, ogon in solid metal gold, tancho with a single clean crown, and shiro, white with crisp ink patches. Every pattern is painted when the fish spawns, so no two are identical.

Around them: schools of tiny minnows that bolt when a koi passes overhead, butterflies that wander and land on flowering lilies, dragonflies that hover and dart, water striders standing on the surface film, oxygen bubbles off the weed beds, lily pads and lotus flowers you can drag, water hyacinth with roots hanging into the water, duckweed drifting in rafts, stepping stones with fish weaving between them, a clay pot on the silty bottom, a wooden rowboat, and cloud shade moving over all of it.

## Sound

A calm recorded water bed, quiet enough to sit under everything, with a single bird call every eleven to thirty-one seconds at a random side and pitch. Clicks and splashes are deliberately silent. The pond is meant to sound like a place, not like an interface.

The audio comes from Mixkit under their licence, which allows commercial and non-commercial use with no attribution required. Sources and the exact ffmpeg commands are in `assets/audio/README.md`.

## Settings

The bar has two panels. `Settings` covers koi count, greenery, bloom, glow, threshold and radius. `Advanced` covers the koi count slider, the small orange fish, each variety's count on its own, planting, and the two sky colours with a gradient amount.

The two panels always agree: the number in Settings is the sum of the varieties in Advanced, so raising it adds a fish to whichever variety is scarcest, and lowering a variety moves that number with it. The pond cannot be emptied below one koi.

## How it is engineered

**One small buffer, stretched.** The scene renders into a target the size of the window divided by 3 or 4 pixels, and the canvas is scaled back up with `image-rendering: pixelated`. At 4 pixels a 1800 pixel wide window is a 450 by 227 render target, a sixteenth of the fragments, and the reason a full pond costs about 2ms a frame. Sprites are painted once onto offscreen canvases, outlined, then alpha hardened to 0 or 255, so nothing turns soft when the buffer is magnified. NEAREST sampling everywhere.

**The frame pipeline.** The bed is drawn first, shaded by depth with caustics where the water is shallow, then the floating pass, then the surface. The surface is one refraction pass: the analytic slope of the swell displaces the whole composed image by whole pixels, so fish and pads bend with the waves instead of sitting on top of them. A bloom pass pulls out only the brightest pixels, so glints and flowers glow while the fish stay crisp. The mood is applied last as a grade: two stop sky veil, glint colour, exposure, contrast, vignette.

**Water on a timeline, not a grid.** Each ring is a jQuery job, a plain object animated from 0 to 1 by jQuery's own ticker, and its step callback turns that timeline into a radius and an amplitude. A ring therefore expands once and fades, and never needs a simulation step. The shader holds 32 rings and sorts them by purpose before strength, which is why a click reaches the screen on its first frame even when a hundred wake rings are alive.

**A real flow field underneath.** A small incompressible field, stable-fluids style, on a 75 by 37 grid: advect the velocity through itself, project it divergence free with fourteen Jacobi passes, then confine vorticity so the eddies behind a stone do not smear out. Stepping stones and the clay pot are solid cells. Duckweed, hyacinth, bubbles and pellets sample the field, fish tails push it, and every splash shoves it. Drag keeps it from accelerating forever, which is the difference between a pond and a river.

**Fish built on a spine.** Each koi steers from a few small urges: its slow wander, spacing from neighbours, a loose pull toward company, the shoreline push, the last click, and food. Heading chases the blend through angular velocity, so turns ease in and out, and the turn rate is capped by the fish's own length. A hard turn also clamps the angle between spine segments, which is what stops a U-turn folding the body through its own tail. The body is a chain of 14 nodes kept at their distances, with a travelling wave added toward the tail in the vertex shader. The sprite is bent by that chain through a silhouette table measured from the painted art, so fins and tail fans survive any bend. Depth is a real variable: a fish that sinks is drawn smaller, tinted toward the deep colour, and its shadow spreads and softens.

**Pads and boat ride the water.** Every floating thing samples the same analytic swell the shader uses, so a pad's height, tilt and small drift come from the water rather than from a timer. Hit testing stays exact because the motion is applied to the pad's real position, not only to how it is drawn.

**The pixel boundary is the collision boundary.** Lily pads, the boat and the stepping stones all resolve against their painted alpha rather than a bounding box. That rule is what removes the invisible grab circle and the invisible wall beside a pointed stone, and it is why a thrown hull can nose into the notch between two stones and stop there.

**Time is fixed, presentation is not.** The simulation runs on a fixed 60Hz step. The frame rate control caps how often the frame is drawn, not how fast the world moves, so 30 and 20 are locked presentation rates and the pond keeps the same speed at every setting.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?seed=123` | reseeds the whole pond: layout, patterns, sizes |
| `?koi=20` | sets the koi count |
| `?px=3` | sets the pixel size |
| `?t=10` | fast-forwards ten seconds before the first frame, handy for links and screenshots |
| `?demo=1` | runs a scripted sequence of ripples and a feeding |

## Files

| File | What is in it |
| --- | --- |
| `index.html` | the page, the panels, the script tags |
| `src/util.js` | seeded randomness, noise, small maths |
| `src/config.js` | every knob |
| `src/textures.js` | every sprite, painted pixel by pixel |
| `src/pond.js` | the shoreline table shared by the CPU and the shaders |
| `src/water.js` | the swell, the ripple jobs, the CPU side queries |
| `src/flow.js` | the incompressible flow field |
| `src/world.js` | scenery layout, pads and boat that ride the water |
| `src/fish.js` | koi behaviour, spines, minnow schools, feeding |
| `src/moods.js` | the six moods and the sky colour controls |
| `src/butterflies.js` `src/dragonflies.js` `src/striders.js` | the small fliers and skaters |
| `src/gfx.js` | shaders, render targets, the frame pipeline |
| `src/main.js` | boot, input, sound, the fixed-step loop, draw order |
| `assets/audio/` | the recorded water and birds |

Tuning lives in `src/config.js` and `src/moods.js`: koi counts and varieties, ripple profiles, water colours and refraction strength, caustics, cloud shade, flow, scenery counts. Edit, reload.

## Inspiration

Inspired by [nagomi](https://github.com/msk1039/nagomi), Mayank Kadam's procedural koi pond, and by the generative koi patterns on [arcade.pirillo.com](https://arcade.pirillo.com/koi-pond.html). Both were read for technique; no code or assets were taken. Independent implementation throughout.

## License

MIT, see [LICENSE](LICENSE).
