/**
 * EXIF GPS Data Test Script
 * 
 * Tests reading EXIF GPS coordinates from an image file.
 * Run with: node test/exif.js
 * 
 * Make sure exifreader is installed: npm install exifreader
 */

const fs = require('fs');
const ExifReader = require('exifreader');

// Test image path - change this to test different files
const TEST_IMAGE = 'D:\\Takeout\\Apple\\extract\\iCloud Photos Part 1 of 8\\Photos\\IMG_97911.JPG';

/**
 * Parse a rational value from EXIF format
 * Handles [numerator, denominator] arrays
 */
function parseRational(val) {
  if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'number' && val[1] !== 0) {
    return val[0] / val[1];
  }
  return typeof val === 'number' ? val : parseFloat(val);
}

/**
 * Parse GPS coordinate from EXIF format to decimal degrees
 * @param {object} coordTag - GPS coordinate tag (GPSLatitude or GPSLongitude)
 * @param {object} refTag - Reference tag (GPSLatitudeRef or GPSLongitudeRef)
 * @returns {number|null} Decimal degrees or null if parsing fails
 */
function parseCoordinate(coordTag, refTag) {
  try {
    if (!coordTag || !refTag) {
      console.log('Missing coordinate or reference tag');
      return null;
    }

    let degrees, minutes, seconds;
    let ref;

    // Get reference value (N, S, E, W)
    if (typeof refTag.value === 'string') {
      ref = refTag.value;
    } else if (Array.isArray(refTag.value) && typeof refTag.value[0] === 'string') {
      ref = refTag.value[0];
    } else if (typeof refTag.description === 'string') {
      ref = refTag.description;
    } else {
      console.log('Unexpected reference format:', refTag);
      return null;
    }

    // Method 1: Direct array of rationals [degrees, minutes, seconds]
    if (Array.isArray(coordTag.value) && coordTag.value.length === 3) {
      [degrees, minutes, seconds] = coordTag.value.map(parseRational);
      console.log(`Parsed from array: ${degrees}° ${minutes}' ${seconds}"`);
    }
    // Method 2: Already a decimal number
    else if (typeof coordTag.value === 'number') {
      const decimal = coordTag.value;
      console.log(`Already decimal: ${decimal}`);
      return (ref === 'S' || ref === 'W') ? -decimal : decimal;
    }
    // Method 3: Parse from description string like "40° 26' 46.8""
    else if (typeof coordTag.description === 'string') {
      const coord = coordTag.description;
      console.log(`Parsing from description: ${coord}`);
      
      // Try format: 40° 26' 46.8"
      const parts = coord.match(/(\d+)°\s*(\d+)'\s*([\d.]+)"/);
      if (parts) {
        degrees = parseFloat(parts[1]);
        minutes = parseFloat(parts[2]);
        seconds = parseFloat(parts[3]);
      } else {
        // Try format without quotes: 40° 26' 46.8
        const altParts = coord.match(/(\d+)°\s*(\d+)'\s*([\d.]+)/);
        if (altParts) {
          degrees = parseFloat(altParts[1]);
          minutes = parseFloat(altParts[2]);
          seconds = parseFloat(altParts[3]);
        } else {
          console.log('Could not parse coordinate format:', coord);
          return null;
        }
      }
    } else {
      console.log('Unexpected coordinate format:', coordTag);
      return null;
    }

    // Convert DMS to decimal degrees
    let decimal = degrees + (minutes / 60) + (seconds / 3600);

    // Apply direction reference
    if (ref === 'S' || ref === 'W') {
      decimal = -decimal;
    }

    console.log(`Result: ${degrees}° ${minutes}' ${seconds}" ${ref} = ${decimal}`);
    return decimal;
  } catch (error) {
    console.error('Error parsing coordinate:', error.message);
    console.error('coordTag:', coordTag);
    console.error('refTag:', refTag);
    return null;
  }
}

// ============================================================
// Main test
// ============================================================

console.log('='.repeat(60));
console.log('EXIF GPS Data Test');
console.log('='.repeat(60));
console.log(`\nReading: ${TEST_IMAGE}\n`);

if (!fs.existsSync(TEST_IMAGE)) {
  console.error('ERROR: File not found:', TEST_IMAGE);
  process.exit(1);
}

const buffer = fs.readFileSync(TEST_IMAGE);
const tags = ExifReader.load(buffer);

console.log('--- Raw GPS Tags ---');
console.log('GPSLatitude:', JSON.stringify(tags.GPSLatitude, null, 2));
console.log('GPSLongitude:', JSON.stringify(tags.GPSLongitude, null, 2));
console.log('GPSLatitudeRef:', JSON.stringify(tags.GPSLatitudeRef, null, 2));
console.log('GPSLongitudeRef:', JSON.stringify(tags.GPSLongitudeRef, null, 2));

console.log('\n--- Parsing Coordinates ---');
const latitude = parseCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef);
const longitude = parseCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef);

console.log('\n--- Results ---');
console.log('Latitude:', latitude);
console.log('Longitude:', longitude);

if (latitude !== null && longitude !== null) {
  console.log(`\nGoogle Maps: https://www.google.com/maps?q=${latitude},${longitude}`);
}

console.log('\n--- Date Tags ---');
console.log('DateTimeOriginal:', tags.DateTimeOriginal?.description || tags.DateTimeOriginal);
console.log('CreateDate:', tags.CreateDate?.description || tags.CreateDate);
console.log('ModifyDate:', tags.ModifyDate?.description || tags.ModifyDate);

console.log('\n' + '='.repeat(60));
