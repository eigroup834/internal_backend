const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: __dirname + '/.env' });

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/company');
const commonRoutes = require('./routes/commonRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api', commonRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
