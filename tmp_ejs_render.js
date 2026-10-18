const fs = require('fs');
const ejs = require('ejs');
const staff = fs.readFileSync('server/views/admin/staff.ejs','utf8');
const reports = fs.readFileSync('server/views/admin/reports.ejs','utf8');
const sampleData = {
  user:{id:'1234',username:'admin',role:'admin'},
  users:[{id:'u1',username:'jdoe',role:'staff',is_active:1,last_login:new Date().toISOString(),created_at:new Date().toISOString()}],
  patientsByMonth:[{month:'2026-01',count:5}],
  newPatientsWeek:7,
  activeStaff:2,
  totalSyncOps:4,
  syncEvents:1
};
try { ejs.render(staff, sampleData, {filename:'server/views/admin/staff.ejs'}); console.log('staff render OK'); } catch(e) { console.error('staff render ERROR', e.stack||e.toString()); }
try { ejs.render(reports, sampleData, {filename:'server/views/admin/reports.ejs'}); console.log('reports render OK'); } catch(e) { console.error('reports render ERROR', e.stack||e.toString()); }
