// Pricing information (per 1 million tokens, except embeddings which are per 1K tokens)
const MODEL_PRICING = {
  "gpt-4o": {
    input: 5,    // $2.50 per 1M input tokens
    output: 10.00,  // $10.00 per 1M output tokens
    image: 7.65,    // $7.65 per 1M image tokens
  },
  "gpt-4.1-2025-04-14": {
    input: 10.00,   // $10.00 per 1M input tokens
    output: 30.00,  // $30.00 per 1M output tokens
    image: 7.65,    // $7.65 per 1M image tokens
  },
  "text-embedding-ada-002": {
    input: 0.0001,  // $0.0001 per 1K tokens
    output: 0,      // No output tokens for embeddings
    image: 0,       // No image tokens for embeddings
  },
  "text-embedding-3-small": {
    input: 0.00002, // $0.00002 per 1K tokens (5x cheaper than ada-002)
    output: 0,      // No output tokens for embeddings
    image: 0,       // No image tokens for embeddings
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
      embeddingModel: null,
      executionModel: null,
      stepBreakdown: [] // Array to store token usage for each step
    };
  }

  addUsage(response, model, hasImage = false, stepInfo = null,agentusage) {
    // Handle both axios response (response.data.usage) and OpenAI SDK response (response.usage)
    let usage = 0;
    if(response){
    if (response.data && response.data.usage) {
      // Axios response structure
      usage = response.data.usage;
    } else if (response.usage) {
      // OpenAI SDK response structure
      usage = response.usage;
    }
  }

    

    if (usage) {
      this.usage.promptTokens += usage.prompt_tokens || 0;
      this.usage.completionTokens += usage.completion_tokens || 0;
      this.usage.totalTokens += usage.total_tokens || 0;

      if (model === 'text-embedding-3-small' || model === 'text-embedding-ada-002') {
        this.usage.embeddingModel = model;
      } else {
        this.usage.executionModel = model;
      }

      if (MODEL_PRICING[model]) {
        // Determine divisor: 1000 for embeddings, 1000000 for GPT models
        const isEmbedding = model.includes('embedding');
        const inputDivisor = isEmbedding ? 1000 : 1000000;
        const outputDivisor = isEmbedding ? 1000 : 1000000;

        let input_usage = 0
        let output_usage = 0
        if(agentusage){
          usage.prompt_tokens += agentusage.ip
          usage.completion_tokens += agentusage.op
        }

        const inputCost = (usage.prompt_tokens / inputDivisor) * MODEL_PRICING[model].input;
        const outputCost = (usage.completion_tokens / outputDivisor) * MODEL_PRICING[model].output;
        let imageCost = 0;
        if (hasImage) {
          this.usage.imageTokens += 85;
          imageCost = (85 / 1000000) * MODEL_PRICING[model].image;
        }
        this.usage.cost += inputCost + outputCost + imageCost;

        // Only push step breakdown if stepInfo is provided
        if (stepInfo) {
          this.usage.stepBreakdown.push({
            step: stepInfo,
            tokens: usage.total_tokens || 0,
            cost: inputCost + outputCost + imageCost,
            model: model
          });
        }
      }
    }
  }

  getUsage() {
    // If all steps are cached, set executionModel to null
    if (this.usage.stepBreakdown.length === 0) {
      this.usage.executionModel = null;
    }
    return this.usage;
  }

  reset() {
    this.usage = {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      imageTokens: 0,
      cost: 0,
      embeddingModel: null,
      executionModel: null,
      stepBreakdown: []
    };
  }
}

// Export the class instead of a singleton instance
export default TokenTracker;
