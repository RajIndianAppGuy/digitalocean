# Use Playwright image as base
FROM mcr.microsoft.com/playwright:v1.47.1-jammy

# Set the working directory
WORKDIR /usr/src/app

# Switch to root user
USER root

# Remove pre-installed nodejs and npm if they exist to avoid conflicts
RUN apt-get remove -y nodejs npm

# Install curl to download node.js
RUN apt-get update && apt-get install -y curl

# Install a specific version of Node.js (e.g., 18.x)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Confirm Node.js and npm versions
RUN node -v && npm -v

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --unsafe-perm=true

# Install Playwright browsers
RUN npx playwright install

# Copy the rest of the application code
COPY . .

# Expose the port on which the API will run (default: 3000)
EXPOSE 3005

# Command to run the API
CMD ["npm", "start"]
