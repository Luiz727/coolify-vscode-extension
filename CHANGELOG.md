# Change Log

All notable changes to the "vscode-coolify" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Security: enforce HTTPS by default during server configuration.
- Security: add `coolify.allowInsecureHttp` setting (disabled by default) for explicit HTTP opt-in.
- Security: harden Webview with CSP + nonce and safer DOM rendering.
- Reliability: introduce typed HTTP client with timeout and API error classification.
- Reliability: improve user-facing error handling for auth/network/server failures.
- Docs: add security notes for transport configuration.