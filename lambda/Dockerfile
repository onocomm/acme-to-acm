# Use AWS Lambda Node.js 22 base image
FROM public.ecr.aws/lambda/nodejs:22

# Install Python 3 and pip (required for Certbot)
RUN dnf install -y \
    python3 \
    python3-pip \
    && dnf clean all

# Install Certbot and Route53 plugin using official installation method
# This ensures we get the latest stable version from PyPI
RUN pip3 install --no-cache-dir \
    certbot \
    certbot-dns-route53

# Verify Certbot installation
RUN certbot --version

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy compiled TypeScript code
COPY dist ./dist

# Set the CMD to your handler
CMD [ "dist/index.handler" ]
