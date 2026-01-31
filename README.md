# FastKV Server

API for querying FastData key-value data stored in ScyllaDB.

**Live:** https://fastdata.up.railway.app

## Endpoints

### Health Check

```
GET /health
```

Response:

```json
{ "status": "ok" }
```

### Get Single Entry

```
GET /v1/kv/get?predecessor_id={account}&current_account_id={contract}&key={key}
```

| Parameter            | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `predecessor_id`     | The account that wrote the data                              |
| `current_account_id` | The contract called (e.g., `social.near`)                    |
| `key`                | The specific key with which to retrieve its respective value |

### Query Multiple Entries

```
GET /v1/kv/query?predecessor_id={account}&current_account_id={contract}&key_prefix={prefix}&exclude_null={bool}
```

| Parameter            | Description                                    |
| -------------------- | ---------------------------------------------- |
| `predecessor_id`     | The account that wrote the data                |
| `current_account_id` | The contract called                            |
| `key_prefix`         | Optional prefix filter (e.g., `graph/follow/`) |
| `exclude_null`       | If `true`, excludes deleted entries            |
| `limit`              | Max results (default: 100)                     |
| `offset`             | Pagination offset                              |

**Example - Get all follows:**

```bash
curl "https://fastdata.up.railway.app/v1/kv/query?predecessor_id=james.near&current_account_id=social.near&key_prefix=graph/follow/&exclude_null=true"
```

### Reverse Lookup

```
GET /v1/kv/reverse?current_account_id={contract}&key={key}&exclude_null={bool}
```

Find all accounts that have a specific key (e.g., "who follows root.near?").

| Parameter            | Description                         |
| -------------------- | ----------------------------------- |
| `current_account_id` | The contract called                 |
| `key`                | The exact key to look up            |
| `exclude_null`       | If `true`, excludes deleted entries |

**Example - Get followers:**

```bash
curl "https://fastdata.up.railway.app/v1/kv/reverse?current_account_id=social.near&key=graph/follow/james.near&exclude_null=true"
```

## Response Format

```json
{
  "entries": [
    {
      "predecessor_id": "james.near",
      "current_account_id": "social.near",
      "key": "graph/follow/root.near",
      "value": "\"\"",
      "block_height": 183302718,
      "block_timestamp": 1769731630602682599,
      "receipt_id": "abc123...",
      "tx_hash": "xyz789..."
    }
  ]
}
```

## Tech Stack

- **Rust** + Actix-web
- **ScyllaDB** - High-performance database
- **Scylla Driver** v1.4

## Development

### Prerequisites

- Rust (nightly recommended)
- ScyllaDB instance

### Environment Variables

```bash
CHAIN_ID=mainnet
SCYLLA_URL=your-scylla-host:9042
SCYLLA_USERNAME=scylla
SCYLLA_PASSWORD=your-password
PORT=3001
```

### Run Locally

```bash
cargo run
```

### Build for Production

```bash
cargo build --release
```

## Deployment

The service includes a Dockerfile for Railway/Docker deployment:

```dockerfile
FROM rustlang/rust:nightly AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/fastkv-server /usr/local/bin/
CMD ["fastkv-server"]
```

## Database Schema

Queries the `s_kv_last` table:

```sql
CREATE TABLE s_kv_last (
    predecessor_id text,
    current_account_id text,
    key text,
    value text,
    block_height bigint,
    block_timestamp bigint,
    receipt_id text,
    tx_hash text,
    PRIMARY KEY ((predecessor_id), current_account_id, key)
);
```

And the `mv_kv_cur_key` materialized view for reverse lookups.

## Related Repositories

- [fastnear-social](https://github.com/MultiAgency/fastnear-social) - Evolving frontend
- [fastfs-server](https://github.com/fastnear/fastfs-server) - API for file system queries
- [fastdata-indexer](https://github.com/fastnear/fastdata-indexer) - Blockchain data pipeline

## License

MIT
