/**
 * ARIXlegal Document Management Controller
 * Handles secure file ingestion, local hashing, quality gating, and document rendering.
 */

const docConfig = {
    MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50MB per Rule 189
    ALLOWED_TYPES: [
        'application/pdf', 
        'image/jpeg', 
        'image/png', 
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
        'text/plain'
    ],
    // API endpoint base for document operations
    DOC_API_BASE: '/api/v1/documents'
};

const docUi = {
    get(id) {
        return document.getElementById(id);
    },
    
    setText(id, text) {
        const el = this.get(id);
        if (el) el.textContent = text;
    },

    showError(message) {
        // Find existing modal error container or create one
        const dropZone = this.get('drop-zone');
        if (!dropZone) return;
        
        let errDiv = document.getElementById('upload-error-msg');
        if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.id = 'upload-error-msg';
            errDiv.className = 'mt-3 text-sm font-medium text-red-600 bg-red-50 p-2 rounded border border-red-200';
            dropZone.parentNode.insertBefore(errDiv, dropZone.nextSibling);
        }
        errDiv.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ${message}`;
        setTimeout(() => { if (errDiv) errDiv.remove(); }, 6000);
    },

    resetDropZone() {
        const dropZone = this.get('drop-zone');
        if (dropZone) {
            dropZone.innerHTML = `
                <i class="fa-solid fa-cloud-arrow-up text-4xl text-gray-400 mb-3"></i>
                <p class="text-gray-700 font-medium">Click to browse or drag files here</p>
                <p class="text-xs text-gray-500 mt-2">Supports PDF, JPG, PNG, DOCX (Max 50MB/file)</p>
            `;
            dropZone.className = 'border-2 border-dashed border-gray-300 rounded-lg p-10 bg-gray-50 hover:bg-blue-50 hover:border-blue-300 transition-colors cursor-pointer';
        }
    }
};

const docSecurity = {
    /**
     * Rule 24: Generate SHA-256 hash locally before upload for provenance.
     */
    async generateFileHash(file) {
        try {
            const buffer = await file.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn("Local hashing failed, fallback to server-side only", e);
            return null;
        }
    },

    /**
     * Rule 26 & 192: Quality gate for images before wasting bandwidth.
     */
    async validateImageQuality(file) {
        if (!file.type.startsWith('image/')) return { valid: true };
        
        return new Promise((resolve) => {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                // Minimum resolution check for legal OCR (approx 150dpi for A4)
                if (img.width < 1000 || img.height < 1000) {
                    resolve({ 
                        valid: false, 
                        reason: "Resolution too low for accurate OCR. Please retake closer to the document." 
                    });
                } else {
                    resolve({ valid: true });
                }
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                resolve({ valid: false, reason: "Corrupted or unreadable image file." });
            };
            
            img.src = objectUrl;
        });
    }
};

const docUploader = {
    init() {
        this.bindDragAndDrop();
    },

    bindDragAndDrop() {
        const dropZone = docUi.get('drop-zone');
        if (!dropZone) return;

        // Prevent default browser behavior
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        // Highlight drop zone
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.add('bg-blue-50', 'border-blue-400');
                dropZone.classList.remove('bg-gray-50', 'border-gray-300');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.remove('bg-blue-50', 'border-blue-400');
                dropZone.classList.add('bg-gray-50', 'border-gray-300');
            }, false);
        });

        // Handle dropped files
        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            this.handleFiles(files);
        }, false);

        // Handle click to browse
        dropZone.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.multiple = true;
            fileInput.accept = docConfig.ALLOWED_TYPES.join(',');
            fileInput.onchange = (e) => this.handleFiles(e.target.files);
            fileInput.click();
        });
    },

    async handleFiles(files) {
        if (!files || files.length === 0) return;

        // Process sequentially to maintain UI responsiveness and avoid overwhelming local memory
        for (let i = 0; i < files.length; i++) {
            await this.processSingleFile(files[i]);
        }
    },

    async processSingleFile(file) {
        // Rule 189: Upload Validation
        if (!docConfig.ALLOWED_TYPES.includes(file.type)) {
            docUi.showError(`"${file.name}" is not a supported file type.`);
            return;
        }

        if (file.size > docConfig.MAX_FILE_SIZE_BYTES) {
            docUi.showError(`"${file.name}" exceeds the 50MB limit.`);
            return;
        }

        this.updateUploadUI(file.name, "Checking image quality...", 10);
        
        // Rule 26: Pre-upload quality check
        const qualityCheck = await docSecurity.validateImageQuality(file);
        if (!qualityCheck.valid) {
            docUi.showError(`Quality Warning for "${file.name}": ${qualityCheck.reason} 
                <button onclick="docUi.resetDropZone()" class="ml-2 underline hover:text-red-800">Dismiss</button>`);
            this.updateUploadUI(file.name, "Upload blocked due to quality.", 0, true);
            setTimeout(() => docUi.resetDropZone(), 4000);
            return;
        }

        this.updateUploadUI(file.name, "Generating secure hash (Rule 24)...", 20);
        const fileHash = await docSecurity.generateFileHash(file);

        // Ready to upload
        await this.performUpload(file, fileHash);
    },

    async performUpload(file, hash) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            // Determine matter ID securely from URL if in case workspace
            const params = new URLSearchParams(window.location.search);
            const matterId = params.get('id') || 'unknown_matter';
            
            xhr.open('POST', `${docConfig.DOC_API_BASE}/upload`, true);
            
            // Set Headers securely
            xhr.setRequestHeader('X-File-Hash', hash || 'unavailable');
            xhr.setRequestHeader('X-Matter-ID', matterId);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 100);
                    // Map upload progress to 20%-80% of total UI progress
                    const mappedProgress = 20 + Math.floor(percentComplete * 0.6);
                    this.updateUploadUI(file.name, `Uploading secure payload... ${percentComplete}%`, mappedProgress);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    // Success - Backend OCR pipeline takes over
                    this.updateUploadUI(file.name, "Processing OCR and AI classification...", 90);
                    
                    // Simulate backend processing time before closing modal
                    setTimeout(() => {
                        this.updateUploadUI(file.name, "Complete", 100);
                        setTimeout(() => {
                            docUi.resetDropZone();
                            // If we are in case context, refresh documents
                            if (window.caseApp) window.caseApp.loadMatterData();
                        }, 1000);
                        resolve(true);
                    }, 1500);
                } else {
                    this.handleUploadFailure(file.name, xhr.status);
                    resolve(false);
                }
            };

            xhr.onerror = () => {
                this.handleUploadFailure(file.name, 'Network Error');
                resolve(false);
            };

            const formData = new FormData();
            formData.append('document', file);
            formData.append('original_filename', file.name);

            // Execute request
            try {
                xhr.send(formData);
            } catch (error) {
                // Graceful degradation when backend is unreachable (Rule 121)
                this.handleUploadFailure(file.name, "Server Offline");
                resolve(false);
            }
        });
    },

    handleUploadFailure(fileName, errorContext) {
        docUi.showError(`Failed to upload "${fileName}". Server responded with: ${errorContext}. Please ensure the legal workspace server is online.`);
        this.updateUploadUI(fileName, "Upload Failed", 0, true);
        setTimeout(() => docUi.resetDropZone(), 3000);
    },

    updateUploadUI(fileName, statusText, percentage, isError = false) {
        const dropZone = docUi.get('drop-zone');
        if (!dropZone) return;

        dropZone.className = 'border border-gray-200 rounded-lg p-6 bg-white shadow-sm';
        
        const colorClass = isError ? 'bg-red-500' : 'bg-blue-600';
        const textClass = isError ? 'text-red-600' : 'text-blue-600';

        dropZone.innerHTML = `
            <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-semibold text-gray-800 truncate pr-4">${fileName}</span>
                <span class="text-xs font-medium ${textClass}">${percentage}%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2 mb-3">
                <div class="${colorClass} h-2 rounded-full transition-all duration-300 ease-out" style="width: ${percentage}%"></div>
            </div>
            <p class="text-xs text-gray-500 text-left flex items-center">
                ${isError ? '<i class="fa-solid fa-circle-xmark mr-1.5 text-red-500"></i>' : '<i class="fa-solid fa-circle-notch fa-spin mr-1.5 text-blue-500"></i>'}
                ${statusText}
            </p>
        `;
    }
};

const docRenderer = {
    renderList(documents) {
        const tbody = docUi.get('document-list-tbody');
        if (!tbody) return;

        tbody.innerHTML = ''; // Safely clear

        if (!documents || documents.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="px-6 py-12 text-center text-gray-400">
                        <i class="fa-regular fa-folder-open text-4xl mb-3"></i>
                        <p>No documents found in this workspace.</p>
                    </td>
                </tr>
            `;
            return;
        }

        documents.forEach(doc => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-gray-50 transition-colors group';
            
            // Name Column (Rule 29: Intelligent Naming)
            const tdName = document.createElement('td');
            tdName.className = 'px-6 py-4';
            const nameContainer = document.createElement('div');
            nameContainer.className = 'flex items-center';
            
            // Icon based on type
            let iconClass = 'fa-file-lines text-gray-400';
            if (doc.type === 'pdf') iconClass = 'fa-file-pdf text-red-400';
            if (doc.type === 'image') iconClass = 'fa-image text-blue-400';
            
            nameContainer.innerHTML = `<i class="fa-solid ${iconClass} mr-3 text-lg"></i>`;
            
            const nameTextDiv = document.createElement('div');
            const normalizedName = document.createElement('p');
            normalizedName.className = 'text-sm font-semibold text-gray-900';
            normalizedName.textContent = doc.normalized_filename || doc.original_filename;
            
            nameTextDiv.appendChild(normalizedName);
            
            if (doc.normalized_filename) {
                const origName = document.createElement('p');
                origName.className = 'text-xs text-gray-400 mt-0.5 font-mono truncate max-w-xs';
                origName.textContent = `Original: ${doc.original_filename}`;
                origName.title = `Hash: ${doc.hash}`; // Rule 24 visibility
                nameTextDiv.appendChild(origName);
            }
            
            nameContainer.appendChild(nameTextDiv);
            tdName.appendChild(nameContainer);

            // Category Column
            const tdCategory = document.createElement('td');
            tdCategory.className = 'px-6 py-4 text-sm text-gray-600';
            tdCategory.textContent = doc.category || 'Unclassified';

            // Date Column
            const tdDate = document.createElement('td');
            tdDate.className = 'px-6 py-4 text-sm text-gray-600';
            tdDate.textContent = doc.document_date || doc.upload_date;

            // Quality/OCR Column (Rule 192/193)
            const tdQuality = document.createElement('td');
            tdQuality.className = 'px-6 py-4 text-sm';
            
            let qualityHtml = '';
            if (doc.ocr_status === 'FAILED') {
                qualityHtml = `<span class="px-2 py-1 bg-red-100 text-red-800 text-xs rounded border border-red-200 font-medium"><i class="fa-solid fa-triangle-exclamation mr-1"></i> OCR Failed</span>`;
            } else if (doc.quality_score === 'POOR') {
                qualityHtml = `<span class="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded border border-yellow-200 font-medium"><i class="fa-solid fa-eye-low-vision mr-1"></i> Poor Quality</span>`;
            } else {
                qualityHtml = `<span class="px-2 py-1 bg-green-100 text-green-800 text-xs rounded border border-green-200 font-medium"><i class="fa-solid fa-check mr-1"></i> Indexed</span>`;
            }
            tdQuality.innerHTML = qualityHtml;

            // Actions Column
            const tdActions = document.createElement('td');
            tdActions.className = 'px-6 py-4 text-right text-sm font-medium';
            tdActions.innerHTML = `
                <button class="text-blue-600 hover:text-blue-900 mr-3" title="View Source"><i class="fa-solid fa-eye"></i></button>
                <button class="text-gray-400 hover:text-gray-600 mr-3" title="Download Original"><i class="fa-solid fa-download"></i></button>
                <button class="text-gray-400 hover:text-red-600" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
            `;

            tr.appendChild(tdName);
            tr.appendChild(tdCategory);
            tr.appendChild(tdDate);
            tr.appendChild(tdQuality);
            tr.appendChild(tdActions);
            
            tbody.appendChild(tr);
        });
    }
};

document.addEventListener('DOMContentLoaded', () => {
    docUploader.init();
});

// Expose renderer to global window so case.js can call it when fetching data
window.docRenderer = docRenderer;
