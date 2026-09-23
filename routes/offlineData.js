const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requireLevel = require("../middleware/requireLevel");
const ctrl = require("../controllers/offlineDataController");

router.use(auth);

const ACCESS = [1, 7];

router.get("/", requireLevel(ACCESS), ctrl.getOfflineDataList);
router.get("/myEntries/list", requireLevel(ACCESS), ctrl.getMyOfflineDataEntries);
router.get("/:srlNo", requireLevel(ACCESS), ctrl.getOfflineDataDetails);
router.post("/", requireLevel(ACCESS), ctrl.addOfflineData);
router.put("/:srlNo", requireLevel(ACCESS), ctrl.updateOfflineData);

module.exports = router;
