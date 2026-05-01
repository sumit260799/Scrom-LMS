require('dotenv').config();
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const csv = require('csv-parser');
const cloudinary = require('cloudinary').v2;
const cors = require('cors'); // Added CORS for React frontend compatibility

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const BASE = '/scorm-lms';
const app = express();

app.use(cors()); // Ensure your React frontend can talk to the backend
app.use(express.json());

// Serve static files from public
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

    // Using unzipper.Open.file for better performance with large ZIPs
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

          // Permanent storage of the original ZIP
          const cloudResponse = await cloudinary.uploader.upload(zipPath, {
            resource_type: 'raw',
            folder: 'scorm_packages',
            public_id: courseId,
          });

          // Cleanup the uploaded ZIP immediately
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

          res.json({
            message: 'Upload successful',
            courseId,
            cloudUrl: cloudResponse.secure_url,
            // Note: This launch URL is dependent on /tmp remaining intact
            launch: `${BASE}/player.html?url=${BASE}/course/${courseId}/${launchFile}`,
            metadata,
          });
        } catch (err) {
          console.error('Processing Error:', err);
          res.status(500).json({error: 'Processing failed'});
        }
      })
      .on('error', err => {
        console.error('Unzip Error:', err);
        res.status(500).json({error: 'Extraction failed'});
      });
  } catch (err) {
    console.error('Server Error:', err);
    res.status(500).json({error: 'Server error'});
  }
});

/**
 * Serve unzipped course files from /tmp
 */
app.use(`${BASE}/course`, express.static(TEMP_COURSES));

const PORT = process.env.PORT || 3044;
app.listen(PORT, () => console.log(`🚀 Port: ${PORT}`));
