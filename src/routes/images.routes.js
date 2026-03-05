const express = require("express");
const imagesController = require("../controllers/images.controller");

const router = express.Router();

// GET /api/cam/images - Get all images with filtering and pagination
router.get("/", imagesController.getImages);

// GET /api/cam/images/:id/annotated - Get annotated image (must come before /:id)
router.get("/:id/annotated", imagesController.getAnnotatedImage);

// GET /api/cam/images/:id/detections - Get detection details (must come before /:id)
router.get("/:id/detections", imagesController.getDetections);

// GET /api/cam/images/:id/download - Download image file (must come before /:id)
router.get('/:id/download', imagesController.downloadImage);

// GET /api/cam/images/:id/serve - Proxy image from MinIO (no auth needed, must come before /:id)
router.get('/:id/serve', imagesController.serveImage);

// GET /api/cam/images/:id - Get single image by ID
router.get("/:id", imagesController.getImageById);

// DELETE /api/cam/images/:id - Delete image
router.delete("/:id", imagesController.deleteImage);

module.exports = router;
