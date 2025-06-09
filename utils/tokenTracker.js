// Pricing information (per 1 million tokens)
const MODEL_PRICING = {
  "gpt-4o": {
    input: 2.50,    // $2.50 per 1M input tokens
    output: 10.00,  // $10.00 per 1M output tokens
    image: 7.65,    // $7.65 per 1M image tokens
  },
  "gpt-4.1-2025-04-14": {
    input: 10.00,   // $10.00 per 1M input tokens
    output: 30.00,  // $30.00 per 1M output tokens
    image: 7.65,    // $7.65 per 1M image tokens
  },
  // Add other models as needed
};

class TokenTracker {
  constructor() {
    this.usage = {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      imageTokens: 0,
      cost: 0,
      model: null,
    };
  }

  addUsage(response, model, hasImage = false) {
    if (response.data.usage) {
      this.usage.promptTokens += response.data.usage.prompt_tokens || 0;
      this.usage.completionTokens += response.data.usage.completion_tokens || 0;
      this.usage.totalTokens += response.data.usage.total_tokens || 0;
      this.usage.model = model;
      
      // Calculate cost
      if (MODEL_PRICING[model]) {
        const inputCost = (this.usage.promptTokens / 1000000) * MODEL_PRICING[model].input;
        const outputCost = (this.usage.completionTokens / 1000000) * MODEL_PRICING[model].output;
        
        // Add image token cost if image was used
        let imageCost = 0;
        if (hasImage) {
          // Each image is considered as 85 tokens
          this.usage.imageTokens += 85;
          imageCost = (85 / 1000000) * MODEL_PRICING[model].image;
        }
        
        this.usage.cost = inputCost + outputCost + imageCost;
      }
    }
  }

  getUsage() {
    return this.usage;
  }
}

// Export a singleton instance
export default new TokenTracker();