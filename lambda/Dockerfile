# Use AWS Lambda OS-only base image (Amazon Linux 2023)
# This approach treats both Node.js and Python as equal dependencies
FROM public.ecr.aws/lambda/provided:al2023

# Install Node.js 22, Python 3.13, and build dependencies
RUN dnf install -y \
    nodejs \
    npm \
    python3.13 \
    python3.13-pip \
    cmake \
    gcc \
    gcc-c++ \
    make \
    tar \
    autoconf \
    automake \
    libtool \
    && dnf clean all

# Install Certbot and Route53 plugin via pip
RUN pip3.13 install --no-cache-dir \
    certbot \
    certbot-dns-route53

# Verify installations
RUN node --version && python3.13 --version && certbot --version

# Set working directory to Lambda task root
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Install AWS Lambda Runtime Interface Client locally
RUN npm install aws-lambda-ric

# Copy TypeScript compiled code
COPY dist ./dist

# Required for Node runtimes which use npm@8.6.0+ because
# by default npm writes logs under /home/.npm and Lambda fs is read-only
ENV NPM_CONFIG_CACHE=/tmp/.npm

# Use the locally installed RIC with npx
ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
# Pass the name of the function handler as an argument to the runtime
CMD ["dist/index.handler"]
