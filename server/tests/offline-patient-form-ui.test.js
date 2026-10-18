const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDirectory = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(
  path.join(publicDirectory, 'offline-workspace.html'),
  'utf8',
);
const styles = fs.readFileSync(
  path.join(publicDirectory, 'offline-workspace.css'),
  'utf8',
);
const script = fs.readFileSync(
  path.join(publicDirectory, 'js', 'offline-workspace.js'),
  'utf8',
);

test('offline patient creation keeps its local form fields grouped by purpose', () => {
  assert.match(html, /class="offline-panel offline-form offline-add-form"/);
  assert.match(html, /<h2 id="offlineFormHeading">Add Patient<\/h2>/);
  for (const heading of [
    'Personal information',
    'Emergency contact',
    'Medical information',
  ]) {
    assert.match(script, new RegExp(`title: '${heading}'`));
  }
  for (const field of [
    'full_name',
    'date_of_birth',
    'gender',
    'phone',
    'address',
    'emergency_contact_name',
    'emergency_contact_phone',
    'emergency_contact_relationship',
    'allergies',
    'medical_history',
    'medications',
  ]) {
    assert.match(script, new RegExp(`'${field}'`));
  }
  assert.match(html, /Enter patient details below\./);
  assert.match(html, /Changes stay on this device until HealthSys confirms/);
});

test('offline patient form uses a contained responsive grid and accessible actions', () => {
  assert.match(
    styles,
    /\.offline-patient-main\s*\{[^}]*width:\s*min\(1100px,\s*100%\)/,
  );
  assert.match(
    styles,
    /\.offline-form-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  );
  assert.match(
    styles,
    /#offlineFormFields,\s*#offlineEditFields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  assert.match(
    styles,
    /\.offline-form :is\(input,\s*select,\s*textarea\)\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*min-width:\s*0/,
  );
  assert.match(styles, /\.offline-form textarea\s*\{[^}]*min-height:\s*100px/);
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.offline-form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 480px\)[\s\S]*?\.offline-form-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  assert.match(html, /id="cancelOfflineForm"/);
  assert.match(html, /Save on this device/);
});

test('offline patient creation retains persistence and exposes a real saving state', () => {
  assert.match(script, /addLocalPatientAndQueue/);
  assert.match(script, /Patient saved on this device and queued/);
  assert.match(script, /addForm\.dataset\.saving = 'true'/);
  assert.match(script, /addSaveButton\.disabled = true/);
  assert.match(script, /finally\s*\{[\s\S]*?addSaveButton\.disabled = false/);
});
