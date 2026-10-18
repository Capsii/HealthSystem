const fs = require('fs');
const ejs = require('ejs');
['server/views/admin/staff.ejs','server/views/admin/reports.ejs'].forEach(p => {
  try {
    ejs.compile(fs.readFileSync(p,'utf8'), {filename:p});
    console.log(p + ': OK');
  } catch (err) {
    console.error(p + ': ERROR');
    console.error(err.stack || err.toString());
  }
});
