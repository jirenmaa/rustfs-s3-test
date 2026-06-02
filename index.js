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
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const tempDir = path.join(__dirname, ".temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}
const upload = multer({ storage: multer.diskStorage({ destination: tempDir, filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`) }) });
const PORT = process.env.PORT || 3000;

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const DEFAULT_BUCKET = process.env.S3_BUCKET || "rustfs-test-bucket";
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "RF_jmgQyUU6kaNNiDKM3VTBteVE";
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "hCjS+QaJNmUV22QFNVsm2PQPaO8RWoYDYip35noETRg=";

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function ensureBucketExists(bucketName) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const code = error?.$metadata?.httpStatusCode === 409 ? "BucketAlreadyExists" : error?.Code || error?.name || "";
    const message = error?.message || "";
    const isBucketExists = code === "BucketAlreadyExists" || 
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

app.post("/api/buckets/:bucket/objects", upload.single("file"), async (req, res) => {
  const bucket = req.params.bucket;
  const file = req.file;
  const key = req.body.key || file?.originalname;

  if (!file || !key) {
    if (file?.path) fs.unlink(file.path, () => {});
    return res.status(400).json({ error: "File and key are required." });
  }

  try {
    await ensureBucketExists(bucket);
    const fileStream = createReadStream(file.path);
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: file.mimetype || "application/octet-stream",
      },
      partSize: 16 * 1024 * 1024, // 16MB chunks
      leavePartsOnError: false,
    });
    await upload.done();
    fs.unlink(file.path, () => {});
    res.json({ message: `Uploaded '${key}' to '${bucket}'.` });
  } catch (error) {
    if (file?.path) fs.unlink(file.path, () => {});
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.get("/api/buckets/:bucket/object", async (req, res) => {
  const bucket = req.params.bucket;
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ error: "Missing object key." });
  }

  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(key)}"`);
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

