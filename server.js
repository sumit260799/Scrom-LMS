require('dotenv').config();
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const csv = require('csv-parser');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const BASE = '/scorm-lms';
const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`CORS Error: Origin ${origin} not allowed`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());

app.use(BASE, express.static(path.join(process.cwd(), 'public')));

const TEMP_UPLOADS = '/tmp/uploads';
const TEMP_COURSES = '/tmp/courses';

const prepareStorage = () => {
  if (!fs.existsSync(TEMP_UPLOADS))
    fs.mkdirSync(TEMP_UPLOADS, {recursive: true});
  if (!fs.existsSync(TEMP_COURSES))
    fs.mkdirSync(TEMP_COURSES, {recursive: true});
};

const upload = multer({dest: TEMP_UPLOADS});

// Helper to handle unzipping as a Promise
const unzipTo = (src, dest) =>
  new Promise((resolve, reject) => {
    fs.createReadStream(src)
      .pipe(unzipper.Extract({path: dest}))
      .on('close', resolve)
      .on('error', reject);
  });

function readMetadata(csvPath) {
  return new Promise(resolve => {
    let metadata = {};
    if (!fs.existsSync(csvPath)) return resolve(metadata);

    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', row => {
        metadata = row;
      })
      .on('end', () => resolve(metadata))
      .on('error', () => resolve({}));
  });
}

app.post(`${BASE}/upload`, upload.single('file'), async (req, res) => {
  try {
    prepareStorage();
    if (!req.file) return res.status(400).json({error: 'No file uploaded'});

    const zipPath = req.file.path;
    const courseId = req.file.filename;
    const extractPath = path.join(TEMP_COURSES, courseId);
    fs.mkdirSync(extractPath, {recursive: true});

    // --- STEP 1: First Extraction (The Container) ---
    await unzipTo(zipPath, extractPath);

    let manifestPath = path.join(extractPath, 'imsmanifest.xml');

    // --- STEP 2: Check for Nested Zip ---
    if (!fs.existsSync(manifestPath)) {
      const csvPath = path.join(extractPath, 'Metadata_File.csv');
      const metadata = await readMetadata(csvPath);
      const innerZipName = metadata['Zip Filename'];

      if (innerZipName) {
        let innerZipPath = path.join(extractPath, innerZipName);

        // Safety: If the CSV says "file.zip" but file on disk has no extension (or vice versa)
        if (!fs.existsSync(innerZipPath)) {
          const alternativeName = innerZipName.endsWith('.zip')
            ? innerZipName.replace('.zip', '')
            : innerZipName + '.zip';
          const altPath = path.join(extractPath, alternativeName);
          if (fs.existsSync(altPath)) innerZipPath = altPath;
        }

        if (fs.existsSync(innerZipPath)) {
          // Extract the inner zip into the same folder
          await unzipTo(innerZipPath, extractPath);
          manifestPath = path.join(extractPath, 'imsmanifest.xml');
        }
      }
    }

    // --- STEP 3: Final Validation ---
    if (!fs.existsSync(manifestPath)) {
      return res.status(400).json({
        error: 'Invalid SCORM (imsmanifest.xml missing after full extraction)',
      });
    }

    // --- STEP 4: Manifest Parsing ---
    const xml = fs.readFileSync(manifestPath, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);

    let launchFile = null;
    const resources = result?.manifest?.resources?.[0]?.resource || [];
    for (let r of resources) {
      if (r.$?.href) {
        launchFile = r.$.href;
        break;
      }
    }

    if (!launchFile)
      return res.status(400).json({error: 'Launch file not found'});

    // Re-read metadata to return to frontend
    const finalMetadata = await readMetadata(
      path.join(extractPath, 'Metadata_File.csv')
    );

    // --- STEP 5: Cloudinary Upload (Original ZIP) ---
    const cloudResponse = await cloudinary.uploader.upload(zipPath, {
      resource_type: 'raw',
      folder: 'scorm_packages',
      public_id: courseId,
    });

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    res.json({
      message: 'Upload successful',
      courseId,
      cloudUrl: cloudResponse.secure_url,
      launch: `${BASE}/player.html?url=${BASE}/course/${courseId}/${launchFile}`,
      metadata: finalMetadata,
    });
  } catch (err) {
    console.error('Server Error:', err);
    res.status(500).json({error: 'Server error'});
  }
});

app.use(`${BASE}/course`, express.static(TEMP_COURSES));

const PORT = process.env.PORT || 3044;
app.listen(PORT, () => console.log(`🚀 Port: ${PORT}`));
