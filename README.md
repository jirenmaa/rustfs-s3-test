# RustFS S3 Test

A lightweight S3-compatible test app for experimenting with RustFS-backed storage.

![preview](/.github/assets/preview.png)

## What it does

- Hosts a simple Express-based UI for uploading, listing, downloading, and deleting objects
- Uses the AWS SDK v3 to communicate with a RustFS S3-compatible endpoint
- Supports standard object operations without complex security or production configuration

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Start the local server:

```bash
npm start
```

3. Open the UI in your browser:

```text
http://localhost:3000
```

## Configuration

The app can be configured with environment variables:

- `S3_ENDPOINT` - RustFS S3 endpoint URL
- `S3_REGION` - AWS region string, default `us-east-1`
- `S3_BUCKET` - default bucket name, default `rustfs-test-bucket`
- `AWS_ACCESS_KEY_ID` - access key for the S3-compatible service
- `AWS_SECRET_ACCESS_KEY` - secret access key for the S3-compatible service

## Notes

- This project is intended for local experimentation and testing
- It is not hardened for production use
- The UI is intentionally simple

#### Workflow

1. Create or ensure the bucket exists using the UI
2. Upload files (images, videos, documents)
3. List objects and verify content
4. Download or delete objects directly from the browser
