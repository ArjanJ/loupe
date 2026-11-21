# System manifest

Some systems don't fit in one repo. They're a web app here, a few services there, a queue, two databases and some third-party APIs. A **system manifest** is a YAML file that describes such a system. You can write it by hand, or have an agent draft it from your design docs. `loupe manifest` turns it into a map.

```sh
loupe manifest system.yaml               # writes system.tree.json
loupe manifest system.yaml --strict      # exit 1 on any error (unknown ids, duplicates)
loupe render system.tree.json            # writes system.html
```

A complete, fictional example is in [`examples/bramble/manifest.yaml`](../examples/bramble/manifest.yaml).

## What you get

| Manifest | On the map |
| --- | --- |
| a repo with two or more services | a folder card that holds those services |
| a repo with one service | the service card itself, at the top level |
| `services` | a service card. Its `exposes` become interface cards inside it, or it holds a whole per-repo map (see `tree`) |
| `datastores` | cards in a **Datastores** group |
| `sharedLibs`, and library repos with no service | cards in a **Shared libraries** group |
| other repos with no service (infra, apps, tooling) | cards in an **Other repos** group |
| `external` | cards in an **External systems** group |
| `calls`, `usedBy` | typed connections (HTTP, async, data, external, webhook, code), each with the manifest line it came from as evidence |
| `flows` | guided tours you can step through or play |
| `status`, `confidence` | ghosted, dashed cards and edges for things not built yet, a status chip, and an **Inferred** tag for low-confidence facts, all repeated in the inspector |

## Schema

Every key is optional except `system.name` and the `id` of each item you want to refer to. Unknown keys are ignored. That way a manifest written for other tools can carry extra fields.

```yaml
version: 1
system:
  name: Bramble                 # required
  description: One or two sentences. The first sentence is the card summary.
  status: built, with tracking in progress      # free text, shown as a note on the root

repos:                          # optional; lets services group by repo
  - name: acme/orders           # required, unique; matched by services[].repo
    label: orders               # card title (default: last path segment)
    role: service | app | library | infrastructure | ...
    description: ...
    runsAs: how it is deployed  # optional
    status: ...                 # see "Status" below

services:
  - id: orders-api              # required, unique across all ids in the file
    name: Orders API            # default: prettified id
    repo: acme/orders
    kind: http service          # free text (http service, worker, web app, mobile app, ...)
    description: ...
    runsAs: container behind the load balancer
    status: built
    confidence: low             # optional; the only value that matters is "low"
    tree: maps/orders.tree.json # optional: a Loupe tree of this repo to drill into (see below)
    exposes:                    # interfaces other things plug into
      - name: POST /orders
        type: rest | grpc | webhook | websocket | screen | ...
        description: Place an order (proposed)   # "(proposed …)" in parentheses also sets status
        status: proposed
    calls:                      # outbound connections
      - to: order-events        # any id: service, datastore, external or library
        via: http | grpc | websocket | queue | event | webhook | db | cache | sdk | import | sandbox
        what: publishes order.paid
        status: branch
        confidence: low
        envVar: ORDER_EVENTS_URL   # optional, listed in the connection details

datastores:
  - id: orders-db
    name: Orders DB
    kind: postgres | redis | queue | bucket | ...
    description: ...
    status: ...
    usedBy:                     # adds a data connection unless the service already calls it
      - orders-api              # a bare id, or:
      - { service: orders-worker, access: read | write | readwrite, what: reads orders, confidence: low }

external:
  - id: stripe
    name: Stripe
    description: ...
    status: ...
    confidence: low
    usedBy: [orders-api]        # adds an external connection if none exists yet

sharedLibs:
  - name: contracts             # id defaults to name
    repo: acme/contracts        # folds that repo into this card
    description: ...
    usedBy: [orders-api, dispatch]   # adds code connections

flows:
  - id: place-order             # default: slug of name
    name: Place an order
    description: One sentence.
    status: tracking is on a branch     # free text, shown under the flow title
    steps:
      - { from: storefront, to: orders-api, via: http, what: POST /orders, status: built }
      - { from: care, to: plant-db, via: http, what: looks up a schedule, status: proposed, confidence: low }
```

### Status

Loupe sorts every status into four lifecycle states. It keeps your full text as a note in the inspector.

| State | Words that select it | Drawn as |
| --- | --- | --- |
| `built` | built, deployed, live, shipped, done, production | normal |
| `branch` | branch, open branch, open PR, PR, in review, WIP, in progress | normal, with an **Open branch** chip |
| `proposed` | proposed, RFC, design, draft, dev-only, spike | ghosted, dashed outline, **Proposed** chip |
| `planned` | planned, agreed, todo, future, not started | more ghosted, dashed outline, **Planned** chip |

The leading word decides the state, so `built (health only) + branch` is built. If no leading word matches, Loupe uses the first lifecycle word anywhere in the text (`client mocked; billing API proposed` → proposed). You can also write `status: { state: branch, note: "Open PR; behind a flag" }`. If a status has no lifecycle word, Loupe shows it as a note only and prints a warning.

A connection without its own status takes the less-built of its two ends: a call into a proposed service is proposed. When several calls between the same two things merge into one edge, the edge counts as built as soon as any one of them is built.

### Confidence

Write `confidence: low` on anything you inferred rather than read in a source. It gets a dashed **Inferred** chip. Its edges are drawn fainter, with "· inferred" on the label. A flow that has inferred steps gets a footnote.

### `via` → connection kind

| `via` | Kind |
| --- | --- |
| http, https, rest, grpc, graphql, rpc, websocket, ws, sse, api | HTTP |
| queue, event(s), bus, pubsub, stream, topic, kafka, sqs, sns, async, message(s) | async |
| webhook(s), callback | webhook |
| db, database, sql, cache, storage, store, read, write, s3, blob | data |
| sdk, external, or http to an `external` item | external |
| import, lib, library, code, package, npm | code |
| sandbox, exec | sandbox |

If Loupe doesn't recognise a `via` value, it draws the connection as HTTP and prints a warning.

### Drill-down into a repo

Set `tree:` on a service to a Loupe tree of that repo, made with `loupe scan` and `loupe relations`. The path is relative to the manifest. The repo's packages, modules and files then appear inside the service card. Their relationships and flows come along too, with ids prefixed by the service id so they can't collide. A missing tree is a warning, and the service falls back to its `exposes`.

### Evidence

Each connection keeps `[manifest file name, line, what]` as its evidence, so the inspector can point back at the line that claims it. Only the file name is stored, never an absolute path.

## Levels

A manifest map has up to six zoom levels: **System → Groups → Services → Interfaces → Details → Files**. Details and Files appear only when a service drills into a per-repo tree.
