import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "fs";

const s3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: "RF_jmgQyUU6kaNNiDKM3VTBteVE",
    secretAccessKey: "hCjS+QaJNmUV22QFNVsm2PQPaO8RWoYDYip35noETRg=",
  },
  forcePathStyle: true, // for S3-compatible storage
});

const BUCKET = "sdk-test-bucket";
const FILE_KEY = "hello.txt";

async function run() {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  console.log("Bucket created");

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: FILE_KEY,
      Body: "Hello from RustFS",
      ContentType: "text/plain",
    })
  );
  console.log("Object uploaded");

  // List objects
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET })
  );
  console.log("Objects:", list.Contents?.map(o => o.Key));

  // Download object
  const data = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: FILE_KEY })
  );

  const body = await data.Body.transformToString();
  console.log("Downloaded content:", body);
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

