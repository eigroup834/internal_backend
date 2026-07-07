process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
require('dotenv').config({ path: __dirname + '/.env' });

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/company');
const commonRoutes = require('./routes/commonRoutes');
const visitorRoutes = require('./routes/visitor');

// require('./jobs/duplicateCheckJob');

const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api', commonRoutes);
app.use('/api/visitor', visitorRoutes);

app.use(express.static(
  path.join(__dirname, '../frontend/build')
));

app.use((req, res) => {
  res.sendFile(
    path.join(__dirname, '../frontend/build/index.html')
  );
});

const PORT = 5010;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on port ${PORT}`)
);
