require('dotenv').config();
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const csv = require('csv-parser');
const cloudinary = require('cloudinary').v2;

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const BASE = '/scorm-lms';
const app = express();

app.use(BASE, express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * VERCEL COMPLIANT PATHS:
 * We avoid creating 'uploads' or 'courses' in the root.
 * All writing MUST happen in /tmp.
 */
const TEMP_UPLOADS = '/tmp/uploads';
const TEMP_COURSES = '/tmp/courses';

// This function safely ensures the /tmp subdirectories exist without crashing
const prepareStorage = () => {
  if (!fs.existsSync(TEMP_UPLOADS))
    fs.mkdirSync(TEMP_UPLOADS, {recursive: true});
  if (!fs.existsSync(TEMP_COURSES))
    fs.mkdirSync(TEMP_COURSES, {recursive: true});
};

const upload = multer({dest: TEMP_UPLOADS});

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
    prepareStorage(); // Ensure /tmp folders are ready

    if (!req.file) return res.status(400).json({error: 'No file uploaded'});

    const zipPath = req.file.path;
    const courseId = req.file.filename;
    const extractPath = path.join(TEMP_COURSES, courseId);

    fs.mkdirSync(extractPath, {recursive: true});

    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({path: extractPath}))
      .on('close', async () => {
        try {
          const manifestPath = path.join(extractPath, 'imsmanifest.xml');

          if (!fs.existsSync(manifestPath)) {
            return res
              .status(400)
              .json({error: 'Invalid SCORM (imsmanifest.xml missing)'});
          }

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

          const csvPath = path.join(extractPath, 'Metadata_File.csv');
          const metadata = await readMetadata(csvPath);

          // Upload to Cloudinary for permanent storage
          const cloudResponse = await cloudinary.uploader.upload(zipPath, {
            resource_type: 'raw',
            folder: 'scorm_packages',
            public_id: courseId,
          });

          // Delete the temporary zip in /tmp/uploads
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

          res.json({
            message: 'Upload successful',
            courseId,
            cloudUrl: cloudResponse.secure_url,
            launch: `${BASE}/player.html?url=${BASE}/course/${courseId}/${launchFile}`,
            metadata,
          });
        } catch (err) {
          res.status(500).json({error: 'Processing failed'});
        }
      })
      .on('error', err => res.status(500).json({error: 'Extraction failed'}));
  } catch (err) {
    res.status(500).json({error: 'Server error'});
  }
});

/**
 * Serve unzipped course files from /tmp
 */
app.use(`${BASE}/course`, express.static(TEMP_COURSES));

const PORT = process.env.PORT || 3044;
app.listen(PORT, () => console.log(`🚀 Port: ${PORT}`));
