import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import fs from "fs";
import { createReadStream } from "fs";
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const tempDir = path.join(__dirname, ".temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}
const upload = multer({
  storage: multer.diskStorage({
    destination: tempDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});
const PORT = process.env.PORT || 3000;

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const DEFAULT_BUCKET = process.env.S3_BUCKET || "rustfs-test-bucket";
const ACCESS_KEY_ID =
  process.env.AWS_ACCESS_KEY_ID || "RF_jmgQyUU6kaNNiDKM3VTBteVE";
const SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY ||
  "hCjS+QaJNmUV22QFNVsm2PQPaO8RWoYDYip35noETRg=";

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

// In-memory upload progress tracking (uploadId -> { loaded, total, percent, state })
const uploadProgressMap = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function ensureBucketExists(bucketName) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const code =
      error?.$metadata?.httpStatusCode === 409
        ? "BucketAlreadyExists"
        : error?.Code || error?.name || "";
    const message = error?.message || "";
    const isBucketExists =
      code === "BucketAlreadyExists" ||
      code === "BucketAlreadyOwnedByYou" ||
      message.includes("already own") ||
      message.includes("BucketAlreadyOwnedByYou") ||
      message.includes("BucketAlreadyExists");
    if (!isBucketExists) {
      throw error;
    }
  }
}

app.get("/api/buckets", async (req, res) => {
  try {
    const result = await s3.send(new ListBucketsCommand({}));
    res.json({ buckets: result.Buckets || [] });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.post("/api/buckets", async (req, res) => {
  const bucket = req.body.Bucket || DEFAULT_BUCKET;
  try {
    await ensureBucketExists(bucket);
    res.json({ message: `Bucket '${bucket}' is ready.` });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.get("/api/buckets/:bucket/objects", async (req, res) => {
  const bucket = req.params.bucket;
  try {
    const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    res.json({ objects: result.Contents || [] });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.post(
  "/api/buckets/:bucket/objects",
  upload.single("file"),
  async (req, res) => {
    const bucket = req.params.bucket;
    const file = req.file;
    const key = req.body.key || file?.originalname;

    if (!file || !key) {
      if (file?.path) fs.unlink(file.path, () => {});
      return res.status(400).json({ error: "File and key are required." });
    }

    try {
      await ensureBucketExists(bucket);
      // uploadId can be provided by client to poll server-side progress
      const taskId =
        req.body.uploadId ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      uploadProgressMap.set(taskId, {
        loaded: 0,
        total: file.size,
        percent: 0,
        state: "in-progress",
      });

      // If file small, use PutObject for simplicity
      const PART_SIZE = 8 * 1024 * 1024; // 8MB
      if (file.size <= PART_SIZE) {
        // simple put
        const stream = createReadStream(file.path);

        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: stream,
            ContentType: file.mimetype || "application/octet-stream",
          }),
        );

        uploadProgressMap.set(taskId, {
          loaded: file.size,
          total: file.size,
          percent: 100,
          state: "done",
        });

        setTimeout(() => uploadProgressMap.delete(taskId), 30 * 1000);
        fs.unlink(file.path, () => {});

        return res.json({
          message: `Uploaded '${key}' to '${bucket}'.`,
          uploadId: taskId,
        });
      }

      // Manual multipart upload with per-part progress updates
      let uploadId = undefined;
      const parts = [];
      try {
        const createRes = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            ContentType: file.mimetype || "application/octet-stream",
          }),
        );
        uploadId = createRes.UploadId;

        const totalParts = Math.ceil(file.size / PART_SIZE);
        let loaded = 0;

        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
          const start = (partNumber - 1) * PART_SIZE;
          const end = Math.min(start + PART_SIZE, file.size);
          const partStream = createReadStream(file.path, {
            start,
            end: end - 1,
          });

          const uploadPartRes = await s3.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: partStream,
            }),
          );

          const etag = uploadPartRes.ETag;
          if (!etag) throw new Error(`Upload part ${partNumber} failed`);

          parts.push({ ETag: etag, PartNumber: partNumber });
          loaded += end - start;
          const percent = Math.round((loaded / file.size) * 100);

          uploadProgressMap.set(taskId, {
            loaded,
            total: file.size,
            percent,
            state: "in-progress",
          });
        }

        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );

        uploadProgressMap.set(taskId, {
          loaded: file.size,
          total: file.size,
          percent: 100,
          state: "done",
        });

        setTimeout(() => uploadProgressMap.delete(taskId), 30 * 1000);
        fs.unlink(file.path, () => {});

        return res.json({
          message: `Uploaded '${key}' to '${bucket}'.`,
          uploadId: taskId,
        });
      } catch (err) {
        // abort multipart if needed
        if (uploadId) {
          try {
            await s3.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
              }),
            );
          } catch (ignore) {}
        }
        if (file?.path) fs.unlink(file.path, () => {});
        uploadProgressMap.set(taskId, {
          loaded: uploadProgressMap.get(taskId)?.loaded || 0,
          total: file.size,
          percent: 0,
          state: "error",
        });
        return res.status(500).json({ error: err.message || String(err) });
      }
    } catch (error) {
      if (file?.path) fs.unlink(file.path, () => {});
      res.status(500).json({ error: error.message || String(error) });
    }
  },
);

// Pollable upload status endpoint
app.get("/api/upload-status", (req, res) => {
  const uploadId = req.query.uploadId;
  if (!uploadId) return res.status(400).json({ error: "uploadId required" });
  const status = uploadProgressMap.get(String(uploadId));
  res.json(status || {});
});

app.get("/api/buckets/:bucket/object", async (req, res) => {
  const bucket = req.params.bucket;
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ error: "Missing object key." });
  }

  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    res.setHeader(
      "Content-Type",
      object.ContentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(key)}"`,
    );
    await pipeline(object.Body, res);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.delete("/api/buckets/:bucket/object", async (req, res) => {
  const bucket = req.params.bucket;
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ error: "Missing object key." });
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    res.json({ message: `Deleted '${key}' from '${bucket}'.` });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

process.on("exit", () => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`S3-compatible UI server running at http://localhost:${PORT}`);
  console.log(`Using S3 endpoint: ${S3_ENDPOINT}`);
  console.log(`Default bucket: ${DEFAULT_BUCKET}`);
  console.log(`Temp directory: ${tempDir}`);
});
