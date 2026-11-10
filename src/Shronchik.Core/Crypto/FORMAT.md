# SRM1 version 1

All integer header fields use little endian. GUID bytes use .NET `Guid.TryWriteBytes` order. The format uses AES-256-GCM with 12-byte nonces and 16-byte tags. Each object has a fresh random 256-bit file key.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 4 | ASCII `SRM1` |
| 4 | 4 | Version, 1 |
| 8 | 16 | Expected object GUID |
| 24 | 4 | Block size, 1048576 |
| 28 | 4 | Random file nonce prefix |
| 32 | 8 | Plaintext length |
| 40 | 8 | Block count |
| 48 | 12 | Random file-key wrapping nonce |
| 60 | 32 | File key encrypted with master key |
| 92 | 16 | File-key wrapping tag |
| 108 | 16 | Header authentication tag |
| 124 | 4 | Reserved, zero |

File-key wrapping AAD is header bytes 0–31. The header tag authenticates bytes 0–107 followed by bytes 124–127, with empty plaintext. Its nonce is the file nonce prefix followed by the big-endian value `UInt64.MaxValue`.

Data follows the 128-byte header. Each full block has 1048576 ciphertext bytes and a 16-byte tag. The last block may have fewer ciphertext bytes. Block nonce is the file prefix followed by the big-endian 64-bit zero-based block index. Data AAD is header bytes 0–31 followed by the little-endian 64-bit block index and little-endian 32-bit actual block length. A fresh random file key prevents nonce reuse between objects; the header uses a counter value reserved from data blocks.

The authenticated plaintext length determines the block count and exact physical file size. Opening rejects a mismatched ID, version, block size, block count, truncated file, or trailing bytes. Range reads verify an entire block before emitting any bytes from that block. They do not authenticate unrelated blocks; a verified header and requested range do not prove integrity of unread content.

Encryption reads arbitrary non-seekable streams, computes SHA-256 while encrypting, and writes an initially invalid header. Only after all ciphertext has been written is the complete authenticated header written and flushed. The caller must use a staging path and atomically publish it alongside the catalogue transaction. Failed writes remove only the file created by that invocation.

# Password wrappers

Argon2id defaults are 65536 KiB, 3 iterations, parallelism 2, a random 16-byte salt, and 32-byte output. AES-GCM wraps the master key with a random 12-byte nonce and 16-byte tag. Serialized wrapper fields contain no plaintext master key or password. Imported KDF parameters and encodings are bounded before use.

Authentication must call the context overload with an independently expected context such as `<library-id-N>:Admin` or `<library-id-N>:User`. The context is authenticated and must not be taken from untrusted wrapper fields. This prevents substituting a User wrapper for an Admin wrapper. Context-free overloads are for generic uses that do not attach identity or role semantics.

Password strings cannot be erased by managed code. Temporary UTF-8 password bytes, derived wrapping keys, per-file keys, and rented plaintext buffers are explicitly cleared. The Argon2 library does not expose cancellation during computation; cancellation is observed before computation and the output is cleared if cancellation arrives while it runs.
