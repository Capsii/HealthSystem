const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { createHttpsRedirect } = require('./transport_security');
const { errorHandler, notFound, requestContext } = require('./error_handlers');
const logger = require('./logger');
const { getAppConfig } = require('./config');

const app = express();
const { sessionSecret, port: PORT, isProduction, httpsRedirectOrigin, trustProxy } = getAppConfig();
const HTTPS_PORT = 3443;

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = new Set(['127.0.0.1', '::1', 'localhost']);
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        ips.add(iface.address);
      }
    }
  }
  return Array.from(ips);
}

// Set EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware FIRST
app.set('trust proxy', trustProxy);
app.use(requestContext);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        server: 'online',
        time: new Date().toISOString()
    });
});

app.use(createHttpsRedirect(isProduction, httpsRedirectOrigin));

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// Static
app.use(express.static(path.join(__dirname, 'public')));

// Routes AFTER session exists
app.use('/', require('./routes/login'));
app.use("/register", require("./routes/register"));
app.use('/patients', require('./routes/patients'));
app.use('/appointments', require('./routes/appointments'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/account', require('./routes/account'));
app.use('/admin/recovery', require('./routes/recovery'));
app.use('/admin', require('./routes/admin'));
app.use('/sync', require('./routes/sync'));

// Root redirect
app.get('/', (req, res) => res.redirect('/login'));

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info('http.listener.ready', { port: PORT });
});

if (!isProduction) {
  const certificatePairs = [
    ['localhost-dev-key.pem', 'localhost-dev-cert.pem'],
    ['localhost+3-key.pem', 'localhost+3.pem'],
  ];
  const certificatePair = certificatePairs.find(([keyName, certName]) =>
    fs.existsSync(path.join(__dirname, 'cert', keyName)) &&
    fs.existsSync(path.join(__dirname, 'cert', certName)),
  );
  if (!certificatePair) {
    throw new Error(
      'Development HTTPS certificate pair is missing. Run node server/generate_dev_cert.js.',
    );
  }
  const credentials = {
    key: fs.readFileSync(path.join(__dirname, 'cert', certificatePair[0])),
    cert: fs.readFileSync(path.join(__dirname, 'cert', certificatePair[1]))
  };
  https.createServer(credentials, app).listen(HTTPS_PORT, () => {
    logger.info('https.listener.ready', { port: HTTPS_PORT });
    logger.info('https.local_addresses', {
      port: HTTPS_PORT,
      addresses: getLocalIps().filter((ip) => ip !== 'localhost'),
    });
  });
}