# Off-the-shelf spring calculator

Work out what force a stock compression spring makes at what length, in both
directions:

* **backward** — I need this force: which catalogue parts can deliver it, and how
  far do I have to compress each one. Force is the only required input; diameter,
  length, travel and material are optional filters that start blank.
* **forward** — this spring, held at this length, pushes this hard.

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

## What you can filter on

Force is the only required input. Everything McMaster publishes for a
compression spring is an optional filter, grouped and blank by default:

| Group | Filters |
|---|---|
| Size | outside diameter (min–max), inside diameter (min–max; a minimum is what clears a rod), wire diameter (min–max), free length (min–max), max installed length, max solid length |
| Behaviour | spring rate (min–max), rated for at least, compress at least, max share of usable travel |
| Construction | material, end type, coil shape (straight only), temperature rating |
| Assumptions | assembly position tolerance, rate tolerance, ranking |

Two deliberate choices. A spring with no published temperature rating is kept
rather than excluded — unknown is not the same as unsuitable, and most catalogue
tables never carry one. And switching between inches and millimetres converts
every value you have typed rather than reinterpreting it.

## Saying it in words

There is a text box above the fields: type *"1.5N in a half inch bore, stainless,
must clear a 2mm rod"* and it fills the fields and searches.

It is a parser (`nl-query.js`), not a language model — no API key, no network, no
cost, and it works offline in the standalone build. A spring request has a small,
sharp vocabulary, so it is parsed rather than guessed at: a force in any unit,
spoken fractions (*half inch*, *1/8*, *1-1/2*), a bore, a rod to clear, an
inside or wire diameter in either direction, a free, installed or solid length,
a minimum travel, a spring rate with its compound unit, an end type, a material,
and a preference (*softest*, *smallest*, *as precise as possible*).

Two rules make it trustworthy rather than magic. Everything it understood is shown
back as chips with the words it came from, and **everything it could not place is
shown too** with the reason — a silent misread would be worse than no parsing.
And it drives the visible fields rather than a hidden state, so you can see and
adjust whatever it did. Where the meaning is genuinely ambiguous it refuses:
*"at least 5mm OD"* is reported as unparsed rather than quietly reversed into a
maximum, because diameter is only filtered as an upper bound.

## The shared catalogue

`data/catalogue.json` carries **1,566 McMaster-Carr straight compression springs,
inch sizes** — the vendor's full filtered listing, extracted from their own
catalogue PDF on 2026-08-29. Every visitor gets them on first load, in any
browser, with nothing to paste. Each row keeps its part number and a link back to
the vendor page.

The listing is five product families printed with **different columns**, so
`tools/extract-mcmaster-pdf.py` parses each with its own pattern — one pattern
across all of them would silently shift values into the wrong fields. Every
parsed row is then checked against the vendor's own arithmetic: rate x (free
length − compressed length at max load) must reproduce the published max load.
1,496 of the 1,504 checkable rows agree within 12%; the 8 that do not were
inspected by hand against the source and are vendor inconsistencies, not parse
errors. Coil counts derived from the published rates round-trip back to those
rates exactly.

| Family | Rows | Note |
|---|---|---|
| Compression Springs | 1,125 | finished parts |
| Cut-to-Length | 166 | sold as stock; cutting changes the rate, so each is flagged |
| Precision | 139 | carry their own OD and rate tolerances |
| Mil. Spec. | 114 | keep their MS part number |
| Plastic (Ultem PEI) | 22 | moulded, rectangular section |

**One inference, stated plainly.** McMaster labels 947 of these "Spring Steel"
without naming a grade. Their properties are taken as music wire (ASTM A228),
inferred from McMaster's own published max loads rather than from any statement of
theirs: assuming hard-drawn A227 puts 513 of 1,523 springs above allowable stress
*at their own rating*, which no vendor would publish; music wire leaves 25. Shear
modulus is identical either way, so rate, coil count and solid length are
unaffected — only the stress column moves.

To update it: print the vendor's filtered listing to PDF, run the extractor, and
commit the result. To add springs by hand instead, paste them into the Catalogue
tab, click **Download as JSON**, and commit that.

The catalogue table carries every field, published and derived: family, material,
ends, OD, ID, wire, free / solid / at-max-load lengths, usable travel, rate and
its tolerance, the vendor's max load beside the max usable load, coil count,
spring index, temperature rating, mil spec, colour, pack quantity and price.
It reads in **the units the vendor published** — inches, pounds, lbf/in and °F for
a US listing — whatever the working units are set to elsewhere on the page, because
a catalogue is a reference list and should match the source it came from. Each
spring records its own `sourceUnits`, so a metric catalogue reads in mm and N.

Anything the calculator worked out rather than read is marked **derived** — solid
length, usable travel, coil count, and any diameter or rate reconstructed from the
others. Two columns are always derived and say so in the heading.

Every heading sorts, and the row beneath them filters — plain text matches what
the cell shows, and number columns also take `>2`, `<=0.5`, `1..3`. Sorting uses
the stored SI value, so a mixed-unit catalogue still orders correctly, and unknown
values sort to the bottom in both directions rather than reading as zero.

A spring carrying **notes** in the catalogue list has something worth knowing
about it — a derived coil count too low for the rate equation to be reliable, a
spring index outside 4–14, rectangular wire, cut-to-length stock, a material with
no published properties. They are observations, not faults, and the badge opens
to read them.

Springs a visitor pastes for themselves stay in their own browser and layer on top
of the shared list, marked `yours` against the shared rows' `shipped`. They can
hide a shipped spring locally without affecting anyone else, and restore it again.
Browser storage has no expiry — it persists until they clear site data, switch
browser, or switch device — and if the browser refuses to save (private window,
full quota) the page now says so instead of failing quietly.

## No bundled vendor data

There is no spring catalogue in this repo, on purpose. Guessed part numbers get
ordered. Instead:

Two paste formats are accepted, told apart automatically:

* **A results table** — header row included; that row names the columns. CSV too.
* **One product page's specification list** — the vertical label/value block.
  Compliance, country-of-origin and export-control lines are dropped; the rest is
  read, including the ones that carry real information and are easy to mishandle:
  *Compressed Length @ Maximum Load* becomes usable travel (it beats anything
  derived from an assumed shear modulus), *Spring Rate Tolerance* replaces the
  blanket ±10% default for that spring, *System of Measurement* sets the units,
  and *Compression Spring Type* warns when a conical or barrel spring would break
  the constant-rate assumption. An extension or torsion spring is refused rather
  than silently mis-modelled. A sheet with no part number still imports — the
  spring is named from its dimensions. Several sheets can be pasted at once.

Either way the import prints back exactly what it read, what it worked out, and
what it ignored, field by field.

* **Paste the vendor's own table.** On mcmaster.com, filter the compression-spring
  table to what you want, select it in the browser, copy, and paste into the
  Catalogue tab. Include the header row — it's what maps the columns. CSV works
  too, as do metric tables.
* `data/catalogue.json` is the shared list described above, and is empty until
  real data is committed to it.
* Nothing else ships. There is no sample data and no demo button: an invented
  part number that reaches a purchase order is the one failure this tool must
  not have. They are
  geometrically self-consistent and fine for trying the tool, but the part numbers
  are made up. Don't order from them.

Imported rows keep their part number and a link back to the vendor page, and
every field the tool worked out rather than read is labelled `derived`.

## Files

| file | what it is |
|---|---|
| `spring-math.js` | the engine — materials, end types, rate, stress, buckling, derivation, search, catalogue-free design space. Pure functions, no DOM, no dependencies. |
| `catalog.js` | pasted-table, spec-sheet and CSV parsing, unit handling, persistence. |
| `nl-query.js` | the plain-English query parser. No model, no network. |
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
