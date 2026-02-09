# osm2arango

Progressive Bun + TypeScript CLI to import OpenStreetMap extracts (e.g. Geofabrik) into ArangoDB, optimized for fast geospatial aggregation later.

Non-goals (this repo):

- Query APIs, isochrone logic, and aggregation functions. This project focuses on import + schema + indexes.

## Requirements

- Bun
- ArangoDB (targeting 3.12)
- `osmium` (optional but currently the default adapter for `.osm.pbf` input)

## Install `osmium` (optional, recommended for `.osm.pbf`)

`osm2arango import <file>.osm.pbf` uses `osmium export -f geojsonseq` under the hood. You need the `osmium` binary in your `PATH`.

macOS (Homebrew):

```bash
brew install osmium-tool
osmium --version
```

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install osmium-tool
osmium --version
```

Arch Linux:

```bash
sudo pacman -S osmium-tool
osmium --version
```

If you cannot (or do not want to) install `osmium`, convert your extract to `.ndjson` elsewhere and import with `--adapter=ndjson`.

## Quickstart

0. Start ArangoDB (optional):

```bash
docker compose up -d arangodb
```

0. Install dependencies:

```bash
bun install
```

0. Lint (optional):

```bash
bun run lint
```

0. Typecheck (optional):

```bash
bun run typecheck
```

0. Test (optional):

```bash
bun test
bun test --coverage
```

1. Configure connection (env or CLI flags):

```bash
export ARANGO_URL="http://127.0.0.1:8529"
export ARANGO_DB="osm"
export ARANGO_USER="root"
export ARANGO_PASS="your-password"
```

2. Bootstrap DB schema + indexes:

```bash
bun run bin/osm2arango bootstrap
```

For very large imports (e.g. `germany-latest.osm.pbf`), consider bootstrapping **without** secondary indexes first to reduce memory/CPU overhead during ingest, then create indexes afterward:

```bash
bun run bin/osm2arango bootstrap --indexes none
# import ...
bun run bin/osm2arango bootstrap # (default: --indexes all)
```

3. Download an extract from Geofabrik:

```bash
bun run bin/osm2arango download europe/germany/berlin
```

4. Import the `.osm.pbf` into ArangoDB (requires `osmium` in `PATH`):

```bash
bun run bin/osm2arango import data/berlin-latest.osm.pbf
```

Large extracts: `osmium export` needs a node-location index to build geometries. The default index type may use a lot of RAM; if you see `osmium export failed with exit code 137` (killed; likely OOM), try a file-based index type:

```bash
bun run bin/osm2arango import data/germany-latest.osm.pbf \
  --osmium-index-type sparse_file_array,/tmp/osmium.node.locations
```

By default, `import` uses `--profile places` (amenities + recreation like forests/water/green areas) and will also default to `--osmium-geometry-types point,polygon` to avoid importing roads as LineStrings. Use `--profile all` to import everything.

Alternative: Import an `.ndjson` file (NDJSON = newline-delimited JSON) that contains one GeoJSON Feature per line:

```bash
bun run bin/osm2arango import data/berlin.ndjson --adapter=ndjson
```

Note: progress and status messages are printed to `stderr` so `stdout` can be piped.

## Wizard (Interactive)

If you prefer a guided flow that mirrors Geofabrik’s region tree (continent -> country -> ...), use the interactive wizard:

```bash
bun run bin/osm2arango wizard
```

Navigation: use Up/Down + Enter, and start typing to filter long lists.

The wizard can import a single extract (e.g. `europe/germany`) or split by direct children (e.g. Germany -> Bundeslaender) to avoid massive one-shot imports.

Power-user flags:

```bash
# Print the plan only (no downloads/import/writes)
bun run bin/osm2arango wizard --plan

# Preselect region + scope (region/children/leaves)
bun run bin/osm2arango wizard --region europe/germany/berlin --scope region
```

Docker (recommended on macOS for very large imports):

```bash
docker compose up -d arangodb
docker compose build importer
docker compose run --rm importer wizard
```

## Import Profiles

The import can be scoped to a smaller, more “place scoring” oriented dataset using `--profile`:

- `places` (default): `amenity=*` plus recreation/nature/green features
- `amenities`: only `amenity=*`
- `recreation`: leisure/nature/green features
- `all`: everything `osmium export` produces

Profiles decide **which features** to import, but do **not** strip tags: all OSM tags for an imported feature are preserved.

Current `places/recreation` matching logic (subject to change as we learn):

- `leisure=*`
- `waterway=*`
- `natural` in: `wood`, `water`, `wetland`, `beach`, `grassland`, `heath`, `scrub`
- `landuse` in: `forest`, `meadow`, `grass`, `recreation_ground`, `village_green`, `allotments`
- `boundary` in: `national_park`, `protected_area`

You can also control geometry volume early via osmium (only relevant for `.osm.pbf`):

- default for non-`all` profiles: `--osmium-geometry-types point,polygon` (drops most roads as LineStrings)
- for full fidelity: `--osmium-geometry-types point,linestring,polygon`

## Data Model (v0)

Collection: `osm_features`

Each document is a single geospatial feature:

- `_key`: stable unique id (prefers osmium's `--add-unique-id=type_id`)
- `geometry`: GeoJSON _Geometry Object_ (not a GeoJSON Feature), in `[longitude, latitude]` order (indexed)
- `tags`: normalized tag object
- `tagsKeys`: tag keys array
- `tagsKV`: `key=value` array
- `osm`: core OSM attributes (`type`, `id`, `timestamp`, ...)

Indexes created by `bootstrap`:

- Geo index on `geometry` (`geoJson: true`)
- Persistent array indexes on `tagsKeys[*]` and `tagsKV[*]`

## Geo Notes (For Later Aggregation Projects)

- ArangoDB's Geo functions/indexing support a useful subset of GeoJSON. GeoJSON **Feature** objects and `GeometryCollection` are not supported by the GeoJSON parser.
- Supported GeoJSON geometry types for geo indexing and `GEO_*` utility functions are: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon`.
- For fast, index-backed filters, prefer **Geo utility functions** like `GEO_DISTANCE()`, `GEO_CONTAINS()`, and `GEO_INTERSECTS()` (instead of deprecated `NEAR()` / `WITHIN()`).
- Important for geo index utilization: the document attribute must be the **second** argument, e.g. `FILTER GEO_INTERSECTS(@shape, doc.geometry)`.
- Import reports a `geometry.type` breakdown at the end. Unsupported types are skipped by default (set `--unsupported-geometry=keep` to store anyway, or `--unsupported-geometry=error` to fail fast).

## Query Examples (AQL / arangojs)

This repository does not ship query APIs, but the imported schema + indexes are designed so consumer projects can do fast geospatial aggregations later (e.g. "what amenities are reachable from a location / isochrone?").

### AQL: Count amenities within a radius around a location

Use this if you have a point (e.g. from geocoding an address). Coordinates are in `[longitude, latitude]` order.

```aql
LET center = GEO_POINT(@lng, @lat)

FOR doc IN osm_features
  // Avoid unsupported geometry types (e.g. GeometryCollection).
  FILTER doc.geometry.type IN ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]
  FILTER GEO_DISTANCE(center, doc.geometry) <= @radiusMeters

  // Uses the array index on tagsKeys[*]
  FILTER "amenity" IN doc.tagsKeys

  COLLECT amenity = doc.tags.amenity WITH COUNT INTO cnt
  SORT cnt DESC
  RETURN { amenity, cnt }
```

### AQL: Find amenities in an isochrone area (e.g. Valhalla)

Valhalla typically returns a GeoJSON FeatureCollection. Extract and pass the _geometry object_ (Polygon/MultiPolygon) as `@isochrone`.
If you only want features that are fully inside the area, use `GEO_CONTAINS(@isochrone, doc.geometry)` instead of `GEO_INTERSECTS(...)`.

```aql
FOR doc IN osm_features
  // Avoid unsupported geometry types (e.g. GeometryCollection).
  FILTER doc.geometry.type IN ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]

  // Uses the geo index if `doc.geometry` is the 2nd argument
  FILTER GEO_INTERSECTS(@isochrone, doc.geometry)

  // Uses the array index on tagsKV[*]
  FILTER (
    "amenity=school" IN doc.tagsKV
    OR "amenity=restaurant" IN doc.tagsKV
  )

  RETURN {
    _key: doc._key,
    amenity: doc.tags.amenity,
    name: doc.tags.name,
    geometry: doc.geometry,
  }
```

### AQL: Nearest restaurants (distance filter + index-backed sort)

```aql
LET center = GEO_POINT(@lng, @lat)

FOR doc IN osm_features
  // Avoid unsupported geometry types (e.g. GeometryCollection).
  FILTER doc.geometry.type IN ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]
  FILTER "amenity=restaurant" IN doc.tagsKV
  FILTER GEO_DISTANCE(center, doc.geometry) <= @radiusMeters
  SORT GEO_DISTANCE(center, doc.geometry) ASC
  LIMIT 20
  RETURN {
    _key: doc._key,
    name: doc.tags.name,
    distanceM: GEO_DISTANCE(center, doc.geometry),
    geometry: doc.geometry,
  }
```

### arangojs 10+: Run an AQL query (TypeScript)

```ts
import { aql, Database } from 'arangojs'

const db = new Database({
  url: process.env.ARANGO_URL!,
  databaseName: process.env.ARANGO_DB!,
  auth: {
    username: process.env.ARANGO_USER!,
    password: process.env.ARANGO_PASS!,
  },
})

const osmFeatures = db.collection('osm_features')

const lng = 13.405
const lat = 52.52
const radiusMeters = 1500

const cursor = await db.query(aql`
  LET center = GEO_POINT(${lng}, ${lat})
  FOR doc IN ${osmFeatures}
    FILTER doc.geometry.type IN ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]
    FILTER "amenity" IN doc.tagsKeys
    FILTER GEO_DISTANCE(center, doc.geometry) <= ${radiusMeters}
    COLLECT amenity = doc.tags.amenity WITH COUNT INTO cnt
    SORT cnt DESC
    RETURN { amenity, cnt }
`)

console.log(await cursor.all())
```

## Help

```bash
bun run bin/osm2arango --help
```
