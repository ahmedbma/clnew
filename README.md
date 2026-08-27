# Off-the-shelf spring calculator

Work out what force a stock compression spring makes at what length, in both
directions:

* **forward** — this spring, held at this length, pushes this hard;
* **backward** — I need this force in this envelope, which catalogue parts can do
  it, and how far do I have to compress each one.

Live page: <https://ahmedbma.github.io/clnew/>

## Why it exists

Vendor catalogues give you OD, ID, wire diameter, free length and spring rate.
They do **not** give you coil count, and therefore not solid height — so the
listing cannot tell you whether your working point is even reachable, or how much
travel you have left when you get there. This tool inverts the rate equation to
recover the coil count, derives solid height and travel from the end treatment,
and reports the working point against it.

It also reports the thing that usually decides whether a design works: **how
tightly you can actually hold the force**. Force error comes from the spring's
own rate tolerance (±10% is normal for commercial stock) and from where the
spring physically ends up (dF/dx = k). A stiff spring nudged slightly is a bad way
to make a small force; a soft spring compressed a long way is a good one. Both
contributions are broken out, worst case and RSS.

## The shared catalogue

`data/catalogue.json` is the list every visitor sees on their first visit, in any
browser, with nothing to paste. It ships **empty** — no verified vendor data has
been added to it yet.

To fill it: paste a vendor table into the Catalogue tab, check the results, click
**Download as JSON**, and commit that file over `data/catalogue.json`. Everyone
gets it on their next visit.

Springs a visitor pastes for themselves stay in their own browser and layer on top
of the shared list, marked `yours` against the shared rows' `shipped`. They can
hide a shipped spring locally without affecting anyone else, and restore it again.
Browser storage has no expiry — it persists until they clear site data, switch
browser, or switch device — and if the browser refuses to save (private window,
full quota) the page now says so instead of failing quietly.

## No bundled vendor data

There is no spring catalogue in this repo, on purpose. Guessed part numbers get
ordered. Instead:

* **Paste the vendor's own table.** On mcmaster.com, filter the compression-spring
  table to what you want, select it in the browser, copy, and paste into the
  Catalogue tab. Include the header row — it's what maps the columns. CSV works
  too, as do metric tables.
* `data/catalogue.json` is the shared list described above, and is empty until
  real data is committed to it.
* `data/example-catalogue.tsv` / `.json` are **synthetic**, and load only when
  someone clicks the example button — never automatically. They are
  geometrically self-consistent and fine for trying the tool, but the part numbers
  are made up. Don't order from them.

Imported rows keep their part number and a link back to the vendor page, and
every field the tool worked out rather than read is labelled `derived`.

## Files

| file | what it is |
|---|---|
| `spring-math.js` | the engine — materials, end types, rate, stress, buckling, derivation, search, catalogue-free design space. Pure functions, no DOM, no dependencies. |
| `catalog.js` | pasted-table and CSV parsing, unit handling, persistence. |
| `app.js` / `index.html` | the browser UI. |
| `cli.mjs` | the same engine from a terminal. |
| `test/spring-math.test.mjs` | `node --test 'test/*.test.mjs'` |

Everything is SI internally (mm, N, N/mm, MPa); units are converted at the edges.

## Command line

```
node cli.mjs design  --force 1.5N --max-od 0.5in
node cli.mjs analyze --od 0.36in --wire 0.032in --free 1in --rate 2.48 --force 1.5N
node cli.mjs find    --force 1.5N --max-od 0.5in --catalog data/example-catalogue.json
node cli.mjs import  pasted.tsv --out data/mcmaster.json
```

Numbers take units inline (`0.5in`, `12.7mm`, `1.5N`, `153gf`, `5.4oz`,
`3.6lbf/in`, `0.63N/mm`); bare numbers follow `--units us` (default) or `--units si`.

`design` needs no catalogue at all — give it a force and an envelope and it tells
you the spring-rate window to filter the vendor's table by, and what a spring at
each rate has to look like.

## The maths

```
F = k·x                    x = L₀ − L
k = G d⁴ / (8 D³ Nₐ)       D = OD − d,  C = D/d
Nₐ = G d⁴ / (8 D³ k)       ← recovers the coil count vendors omit
Lₛ = Nₜ d                  (ground ends; (Nₜ+1)d if not ground)
τ  = Kₛ · 8FD/(πd³)        Kₛ = 1 + 0.5/C  (static), Wahl for cyclic
Sᵤₜ = A/dᵐ                 Shigley table 10-4; allowable τ is a fraction of it
```

Usable travel is the vendor's rated max deflection where published, otherwise 85%
of travel to solid — running a stock spring to solid is how it takes a set and
stops being the spring you specified. Buckling uses the Shigley criterion, with
the end-restraint factor, because small-diameter springs get slender fast.

Round wire, helical compression, static or low-cycle duty. No fatigue life, no
surge frequency, and the rate is treated as constant (real springs stiffen in the
last 15–20% of travel as end coils close). None of it substitutes for measuring
the spring you were actually shipped.
