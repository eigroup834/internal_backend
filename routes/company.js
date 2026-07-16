const express = require('express');
const router = express.Router();
const companyController = require('../controllers/companyController');
const authenticateToken = require('../middleware/auth');

router.get('/getCompanies', authenticateToken, companyController.getCompanies);
router.get('/getAllCompanies', authenticateToken, companyController.getAllCompaniesWithSearch);
router.post("/addCompany", authenticateToken, companyController.addCompany);
router.post("/addPerson", authenticateToken, companyController.addPerson);
router.get("/getPersonList", authenticateToken, companyController.getPersonList);
router.get("/getCompPersonList", authenticateToken, companyController.getCompPersonList);
router.get("/getPersonDetails/:personCode", authenticateToken, companyController.GetPersonDetail);
router.put("/updatePerson/:personCode", authenticateToken, companyController.EditPerson);
router.put("/personCupdRemark/:personCode", authenticateToken, companyController.updatePersonCupdRemark);
router.put("/companyRemark/:companyCode", authenticateToken, companyController.updateCompanyRemark);

router.post("/updateHistory", authenticateToken, companyController.addCompanyHistory);
router.get("/history", authenticateToken, companyController.getCompanyExhHistory);
router.get("/exhibitions", authenticateToken, companyController.getExhibitionNames);
router.delete("/history/:exhCode", authenticateToken, companyController.deleteExhibitionHistory);
router.put("/history/:exhCode", authenticateToken, companyController.updateCompanyHistory);

router.get("/personHistory", authenticateToken, companyController.getPersonExhHistory);
router.post("/updatePersonHistory", authenticateToken, companyController.addPersonHistory);
router.delete("/personHistory/:exhCode", authenticateToken, companyController.deletePersonExhibitionHistory);
router.put("/personHistory/:exhCode", authenticateToken, companyController.updatePersonHistory);

router.get("/industries", authenticateToken, companyController.getIndustries);
router.get("/industries/segments", authenticateToken, companyController.getSegmentsByIndustry);
router.get("/industries-with-segments", authenticateToken, companyController.getIndustriesWithSegments);

router.get("/:companyCode", authenticateToken, companyController.GetCompanyDetail); 
router.put("/updateCompany/:companyCode", authenticateToken, companyController.EditCompany);

router.post("/exportCompany", authenticateToken, companyController.exportCompanies); 

module.exports = router;
