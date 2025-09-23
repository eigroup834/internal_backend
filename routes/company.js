const express = require('express');
const router = express.Router();
const companyController = require('../controllers/companyController');
const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, companyController.getCompanies);
router.post("/addCompany", authenticateToken, companyController.addCompany);

router.get("/industries", authenticateToken, companyController.getIndustries);
router.get("/industries/segments", authenticateToken, companyController.getSegmentsByIndustry);
router.get("/industries-with-segments", authenticateToken, companyController.getIndustriesWithSegments);

router.get("/:companyCode", authenticateToken, companyController.GetCompanyDetail); 
router.put("/updateCompany/:companyCode", authenticateToken, companyController.EditCompany);

router.post("/exportCompany", authenticateToken, companyController.exportCompanies); 

module.exports = router;
