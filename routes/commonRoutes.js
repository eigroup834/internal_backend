const express = require('express');
const router = express.Router();
const commonController = require('../controllers/commonController');

router.get('/countries', commonController.getCountries);
router.get('/states', commonController.getStates);
router.get('/cities', commonController.getCities);

module.exports = router;
