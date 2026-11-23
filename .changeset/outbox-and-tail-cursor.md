---
"sessionpipe-core": patch
---

`Outbox` recovers a missing `.seq` counter from the tail of the session's JSONL outbox in 8 KiB reverse chunks instead of reading and splitting the whole file, and JSONL transcript adapters (`claude-code`, `codex`, `gemini-cli`, `antigravity`, `grok-build`) read growing transcripts incrementally from a cached `(file, dev, ino, byteOffset)` cursor during settle polling, falling back to byte 0 on truncation, inode rotation, or in-place rewrite.
