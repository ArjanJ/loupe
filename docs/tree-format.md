# Tree format

`loupe render` accepts one JSON document. `loupe scan`, `loupe relations` and `loupe manifest` all write it, and you can also produce it yourself.

```jsonc
{
  "meta": {
    "source": "github.com/owner/repo",   // a github.com source links the commit to GitHub
    "commit": "3f9c2e1a7b04d58e9c61f20b3a4d7e8c5f1a2b90",  // full SHA of HEAD when the map was made
    "dirty": false,                      // true if tracked files had uncommitted changes
    "generatedAt": "2026-11-22T10:00:00.000Z",
    "levels": 4,
    "levelNames": ["system", "packages", "modules", "files"],  // one per depth, for the level switcher
    "nodeCount": 300
  },
  "root": {
    "id": "system", "label": "My app", "kind": "system", "path": ".", "weight": 1000,
    "shortDescription": "One sentence.", "longDescription": "A few sentences.",
    "children": [ /* nodes */ ],
    "edges": [],
    "relations": [ /* typed relationships between any two nodes */ ],
    "rollups": { "pkg:a|pkg:b": { "label": "renders the scene", "summary": "One sentence." } },
    "flows": [ /* guided tours */ ]
  }
}
```

`commit`, `dirty` and `generatedAt` are optional. When present, the viewer shows them as a small stamp in the bottom-left corner: the short SHA (hover for the full one, click to copy), "modified" when `dirty` is true, and the date. `loupe scan` fills them in; `loupe manifest` sets only `generatedAt`. A `commit` that isn't 4–64 hex digits is ignored.

## Node

| Field | Meaning |
| --- | --- |
| `id` | unique string |
| `label` | card title |
| `kind` | sets the glyph: `system`, `package`, `module`, `file`, `service`, `datastore`, `library`, `repo`, `group`, `endpoint`, `external` |
| `path` | small monospace caption |
| `weight` | relative area (lines of code, or any size measure) |
| `shortDescription`, `longDescription` | card text, shown as the card opens |
| `functions` | optional list of notable symbols, shown on file cards |
| `children` | child nodes |
| `edges` | optional `{from, to, weight}` between children (untyped dependency hints) |
| `external` | `true` for the outside-world group |
| `status` | `branch`, `proposed` or `planned` (absent = built) |
| `statusNote` | free text shown in the inspector |
| `confidence` | `low` marks the node **Inferred** |

A child whose id starts with `more:` is drawn quietly, as a "+N more files" card.

## Relation

```jsonc
{ "id": "r0", "from": "<node id>", "to": "<node id>",
  "kind": "http | queue | db | external | webhook | sandbox | import",
  "label": "POST /orders", "count": 3,
  "details": ["POST /orders", "GET /orders/:id"],
  "evidence": [["src/api/orders.ts", 42, "app.post('/orders', ...)"]],
  "status": "proposed", "confidence": "low" }
```

Relations usually connect leaves. The viewer rolls them up to whatever level is on screen, and labels the rolled-up edges with `rollups["<from>|<to>"]` when there is an entry.

## Flow

```jsonc
{ "id": "checkout", "title": "Checkout", "summary": "One sentence.",
  "status": "free text", "footnote": "free text",
  "steps": [{ "from": "<id>", "to": "<id>", "kind": "http", "text": "posts the cart",
              "detected": true, "tags": ["proposed", "inferred"] }] }
```

`detected: false` marks a step that no detected relation backs; the viewer tags it **inferred** unless `tags` says otherwise.

All strings are treated as text: the renderer escapes the JSON for the `<script>` block, and the viewer never injects tree content as HTML.
